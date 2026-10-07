import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/map/map_config_provider.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/features/offline_map/data/file_downloader.dart';
import 'package:amar_elaka_app/features/offline_map/data/offline_map_api.dart';
import 'package:amar_elaka_app/features/offline_map/data/offline_map_repository.dart';
import 'package:amar_elaka_app/features/offline_map/domain/offline_areas.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';

import '../../core/map/map_test_support.dart';
import '../post/post_test_harness.dart' show memoryDatabase;

/// A tiny static file host with the tiles route's behaviour (ADR 043): 206
/// for a `Range`, 200 otherwise. [dropAfter] cuts a body after that many
/// bytes, once; [ignoreRange] answers 200 to everything.
class TestFileServer {
  TestFileServer._(this._server);

  static Future<TestFileServer> start(Map<String, Uint8List> files) async {
    final server = TestFileServer._(
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
    );
    server.files.addAll(files);
    server._server.listen(server._handle);
    return server;
  }

  final HttpServer _server;
  final files = <String, Uint8List>{};
  final ranges = <String?>[];
  int? dropAfter;
  bool ignoreRange = false;

  String url(String path) => 'http://127.0.0.1:${_server.port}/$path';

  Future<void> _handle(HttpRequest request) async {
    final path = Uri.decodeComponent(request.uri.path.substring(1));
    final body = files[path];
    final range = request.headers.value('range');
    ranges.add(range);
    final response = request.response;
    if (body == null) {
      response.statusCode = 404;
      await response.close();
      return;
    }
    var start = 0;
    if (range != null && !ignoreRange) {
      start = int.parse(RegExp(r'bytes=(\d+)-').firstMatch(range)!.group(1)!);
      response.statusCode = 206;
      response.headers.set(
        'content-range',
        'bytes $start-${body.length - 1}/${body.length}',
      );
    }
    var part = body.sublist(start);
    final drop = dropAfter;
    if (drop != null && drop < part.length) {
      dropAfter = null;
      part = part.sublist(0, drop);
      // Promise the whole body, send part of it, then hang up.
      response.contentLength = body.length - start;
      final socket = await response.detachSocket();
      socket.add(part);
      await socket.flush();
      socket.destroy();
      return;
    }
    response.contentLength = part.length;
    response.add(part);
    await response.close();
  }

  Future<void> close() => _server.close(force: true);
}

Uint8List bytesOf(int length, [int seed = 7]) =>
    Uint8List.fromList([for (var i = 0; i < length; i++) (i * seed) % 256]);

String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

/// Two areas: an upazila square and a union square inside it, with a hole.
Map<String, dynamic> testAreasGeoJson() => {
  'type': 'FeatureCollection',
  'features': [
    {
      'type': 'Feature',
      'properties': {
        'id': 'upazila',
        'level': 'upazila',
        'adm_level': 3,
        'name_bn': 'মিরপুর',
        'name_en': 'Mirpur',
      },
      'geometry': {
        'type': 'MultiPolygon',
        'coordinates': [
          [
            [
              [90.30, 23.75],
              [90.45, 23.75],
              [90.45, 23.85],
              [90.30, 23.85],
              [90.30, 23.75],
            ],
          ],
        ],
      },
    },
    {
      'type': 'Feature',
      'properties': {
        'id': 'union',
        'level': 'union',
        'adm_level': 4,
        'name_bn': 'পল্লবী',
        'name_en': 'Pallabi',
      },
      'geometry': {
        'type': 'Polygon',
        'coordinates': [
          [
            [90.35, 23.80],
            [90.40, 23.80],
            [90.40, 23.84],
            [90.35, 23.84],
            [90.35, 23.80],
          ],
          // A hole (a lake): not Pallabi, still Mirpur.
          [
            [90.37, 23.81],
            [90.38, 23.81],
            [90.38, 23.82],
            [90.37, 23.82],
            [90.37, 23.81],
          ],
        ],
      },
    },
  ],
};

class FakeOfflineMapApi implements OfflineMapApi {
  FakeOfflineMapApi(this.next);

  OfflineMapManifest next;
  AppException? error;
  var manifestCalls = 0;

  @override
  Future<OfflineMapManifest> manifest() async {
    manifestCalls++;
    if (error case final e?) throw e;
    return next;
  }

  @override
  Future<Map<String, dynamic>> areas() async => testAreasGeoJson();
}

MapFeature offlinePoint(
  String id,
  String layer,
  double lng,
  double lat, {
  String? kind,
  String? nameBn,
}) => MapFeature(
  id: id,
  geometry: MapPointGeometry(coordinates: [lng, lat]),
  properties: MapFeatureProperties(
    cluster: false,
    layer: layer,
    kind: kind,
    id: id,
    tenantId: 't1',
    nameBn: nameBn,
  ),
);

/// The essentials as `/map/features` gives them per point set; the same
/// hospital comes back for two sets (deduplicated on install).
class FakePointsMapApi implements MapApi {
  final queries = <({Set<String>? layers, Set<String>? kinds, double zoom})>[];
  final boxes = <LatLngBox>[];

  /// Answer `clipped` for a box wider than this (degrees of longitude), as
  /// the API does past `map_viewport_max_radius_km`.
  double? clipWiderThan;

  @override
  Future<MapConfig> config() async => testMapConfig;

  @override
  Future<MapFeatures> features({
    required LatLngBox bbox,
    required double zoom,
    Set<String>? layers,
    Set<String>? kinds,
    bool openNow = false,
  }) async {
    queries.add((layers: layers, kinds: kinds, zoom: zoom));
    boxes.add(bbox);
    final clip = clipWiderThan;
    final clipped = clip != null && bbox.maxLng - bbox.minLng > clip;
    final hospital = offlinePoint(
      'h1',
      'places',
      90.369,
      23.807,
      kind: 'hospital',
      nameBn: 'মিরপুর জেনারেল হাসপাতাল',
    );
    return MapFeatures(
      zoom: zoom.floor(),
      layers: [...?layers],
      clustered: false,
      clipped: clipped,
      truncated: false,
      openNowSkipped: const [],
      features: [
        if (layers?.contains('places') ?? false) hospital,
        if (layers?.contains('info') ?? false) ...[
          hospital,
          offlinePoint('i1', 'info', 90.37, 23.81, nameBn: 'থানা'),
        ],
        if (layers?.contains('landmarks') ?? false)
          offlinePoint(
            'l1',
            'landmarks',
            90.36,
            23.80,
            nameBn: 'মিরপুর স্টেডিয়াম',
          ),
      ],
    );
  }

  @override
  Future<MapPreview> preview({
    required String layer,
    required String id,
    required String tenantId,
  }) => throw const NetworkException();

  @override
  Future<MapDistance> distance({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
  }) => throw const NetworkException();

  @override
  Future<RouteAnswer> route({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
    required String mode,
  }) => throw const NetworkException();
}

/// The manifest the API would give for [server]'s files.
OfflineMapManifest manifestFor(
  TestFileServer server, {
  String version = '20261001',
  Map<String, Uint8List>? assets,
}) {
  final archive = server.files['tenants/mirpur-$version.pmtiles']!;
  final assetFiles = assets ?? const <String, Uint8List>{};
  final assetsBytes = assetFiles.values.fold(0, (sum, b) => sum + b.length);
  return OfflineMapManifest(
    available: true,
    reason: null,
    archive: OfflineArchive(
      path: 'tenants/mirpur-$version.pmtiles',
      url: server.url('tenants/mirpur-$version.pmtiles'),
      bytes: archive.length,
      sha256: sha256Hex(archive),
      version: version,
      maxZoom: 14,
      bounds: const [90.30, 23.75, 90.45, 23.85],
      builtAt: '2026-10-01T00:00:00Z',
    ),
    assets: [
      for (final MapEntry(:key, :value) in assetFiles.entries)
        OfflineFile(
          path: key,
          url: server.url(key),
          bytes: value.length,
          sha256: sha256Hex(value),
        ),
    ],
    assetsBytes: assetsBytes,
    totalBytes: archive.length + assetsBytes,
    pointSets: const [
      OfflinePointSet(
        layers: ['info', 'places'],
        kinds: ['hospital', 'pharmacy'],
      ),
      OfflinePointSet(layers: ['info'], kinds: null),
      OfflinePointSet(layers: ['landmarks'], kinds: null),
    ],
    labelLanguage: 'bn',
    updateCheckHours: 24,
  );
}

/// Copies of a manifest with one thing changed.
abstract final class OfflineMapManifestCopy {
  static OfflineMapManifest withArchiveSha(OfflineMapManifest m, String sha) {
    final a = m.archive!;
    return OfflineMapManifest(
      available: m.available,
      reason: m.reason,
      archive: OfflineArchive(
        path: a.path,
        url: a.url,
        bytes: a.bytes,
        sha256: sha,
        version: a.version,
        maxZoom: a.maxZoom,
        bounds: a.bounds,
        builtAt: a.builtAt,
      ),
      assets: m.assets,
      assetsBytes: m.assetsBytes,
      totalBytes: m.totalBytes,
      pointSets: m.pointSets,
      labelLanguage: m.labelLanguage,
      updateCheckHours: m.updateCheckHours,
    );
  }
}

/// The downloaded map without files or a database: what's "installed" is
/// set directly. Default: nothing downloaded.
class FakeOfflineMapRepository extends OfflineMapRepository {
  FakeOfflineMapRepository({
    this.row,
    this.pointRows = const [],
    this.areaIndex,
    this.kindList = const [],
  }) : super(
         db: _sharedDb,
         api: FakeOfflineMapApi(_unavailable),
         mapApi: FakePointsMapApi(),
         downloader: FileDownloader(testDio()),
         supportDir: () async => Directory.systemTemp,
       );

  /// Never queried (every read is overridden); one for all, so drift doesn't
  /// warn about many databases.
  static final _sharedDb = memoryDatabase();

  static const _unavailable = OfflineMapManifest(
    available: false,
    reason: 'not_built',
    archive: null,
    assets: [],
    assetsBytes: 0,
    totalBytes: 0,
    pointSets: [],
    labelLanguage: 'bn',
    updateCheckHours: 24,
  );

  /// `GET /map/offline` when the cut exceeded `offline_map_max_mb`.
  static const tooLarge = OfflineMapManifest(
    available: false,
    reason: 'too_large',
    archive: null,
    assets: [],
    assetsBytes: 0,
    totalBytes: 0,
    pointSets: [],
    labelLanguage: 'bn',
    updateCheckHours: 24,
  );

  OfflineMapRow? row;
  List<OfflinePointRow> pointRows;
  OfflineAreaIndex? areaIndex;
  List<MapKind> kindList;

  @override
  Stream<OfflineMapRow?> watch(String tenantId) => Stream.value(row);

  @override
  Future<OfflineMapRow?> current(String tenantId) async => row;

  @override
  Future<List<OfflinePointRow>> points(String tenantId) async => pointRows;

  @override
  Future<OfflineAreaIndex?> areas(String tenantId) async =>
      row == null ? null : areaIndex;

  @override
  Future<List<MapKind>> kinds(String tenantId) async => kindList;
}

/// An installed Mirpur map as Drift holds it.
OfflineMapRow installedRow({
  String version = '20261001',
  DateTime? checkedAt,
}) => OfflineMapRow(
  tenantId: 't1',
  version: version,
  archivePath: '/data/offline_map/t1/$version/archive.pmtiles',
  assetsDir: '/data/offline_map/t1/$version',
  areasPath: '/data/offline_map/t1/$version/areas.json',
  bytes: 2 * 1024 * 1024,
  sha256: 'abc',
  maxZoom: 14,
  minLng: 90.30,
  minLat: 23.75,
  maxLng: 90.45,
  maxLat: 23.85,
  labelLanguage: 'bn',
  updateCheckHours: 24,
  downloadedAt: DateTime.utc(2026, 10, 1),
  checkedAt: checkedAt ?? DateTime.utc(2026, 10, 1),
);

/// Like the app's downloader client (fileDownloaderProvider): every request
/// gives up rather than wait forever, so a connection whose close went
/// missing under load fails and resumes instead of hanging the test.
Dio testDio() => Dio(
  BaseOptions(
    connectTimeout: const Duration(seconds: 5),
    receiveTimeout: const Duration(seconds: 10),
  ),
);

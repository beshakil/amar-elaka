import 'dart:convert';
import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/map/map_config_provider.dart';
import '../../../core/storage/app_database.dart';
import '../../../core/storage/app_database_provider.dart';
import '../domain/offline_areas.dart';
import 'file_downloader.dart';
import 'offline_map_api.dart';

/// Points are fetched past the server's clustering zoom, so every one comes
/// back as itself (MapLibre zooms run to 22; the API accepts them).
const _pointsZoom = 20.0;
const _archiveName = 'archive.pmtiles';
const _areasName = 'areas.json';

/// How many times a clipped or truncated point box is quartered (at most
/// 4 + 16 + 64 extra requests per point set — a large upazila, once).
const _maxSplits = 3;
const _kindsName = 'kinds.json';

/// The downloaded map area on disk and in Drift (ADR 050).
///
/// `install` downloads into `<support>/offline_map/<tenant>/staging-<version>/`
/// — files already there resume where they stopped — verifies every file's
/// sha256, fetches the area outlines and the essential points, then renames
/// the staging directory to `<version>/` and swaps the Drift rows in one
/// transaction. Until that moment the old version keeps working; afterwards
/// older versions are deleted.
class OfflineMapRepository {
  OfflineMapRepository({
    required this._db,
    required this._api,
    required this._mapApi,
    required this._downloader,
    required this._supportDir,
  });

  final AppDatabase _db;
  final OfflineMapApi _api;
  final MapApi _mapApi;
  final FileDownloader _downloader;
  final Future<Directory> Function() _supportDir;
  final _areasCache = <String, OfflineAreaIndex>{};

  Future<Directory> _tenantDir(String tenantId) async =>
      Directory('${(await _supportDir()).path}/offline_map/$tenantId');

  Stream<OfflineMapRow?> watch(String tenantId) => (_db.select(
    _db.offlineMaps,
  )..where((t) => t.tenantId.equals(tenantId))).watchSingleOrNull();

  Future<OfflineMapRow?> current(String tenantId) => (_db.select(
    _db.offlineMaps,
  )..where((t) => t.tenantId.equals(tenantId))).getSingleOrNull();

  Future<OfflineMapManifest> manifest() => _api.manifest();

  Future<List<OfflinePointRow>> points(String tenantId) => (_db.select(
    _db.offlinePoints,
  )..where((t) => t.tenantId.equals(tenantId))).get();

  /// The downloaded area outlines (null without a download); parsed once.
  Future<OfflineAreaIndex?> areas(String tenantId) async {
    final row = await current(tenantId);
    final path = row?.areasPath;
    if (path == null) return null;
    final cached = _areasCache[path];
    if (cached != null) return cached;
    try {
      final index = OfflineAreaIndex.fromGeoJson(
        jsonDecode(await File(path).readAsString()) as Map<String, dynamic>,
      );
      return _areasCache[path] = index;
    } on Object {
      return null;
    }
  }

  /// The `map_kinds` saved with the download (icons and names offline).
  Future<List<MapKind>> kinds(String tenantId) async {
    final row = await current(tenantId);
    if (row == null) return const [];
    try {
      final raw = await File('${row.assetsDir}/$_kindsName').readAsString();
      return [
        for (final k in jsonDecode(raw) as List)
          MapKind.fromJson(k as Map<String, dynamic>),
      ];
    } on Object {
      return const [];
    }
  }

  /// Downloads (or resumes), verifies and installs [manifest]'s files.
  /// [onProgress]: bytes done of [OfflineMapManifest.totalBytes].
  Future<OfflineMapRow> install(
    String tenantId,
    OfflineMapManifest manifest, {
    void Function(int done, int total)? onProgress,
    CancelToken? cancel,
  }) async {
    final archive = manifest.archive;
    if (archive == null) throw StateError('no archive to download');
    final root = await _tenantDir(tenantId);
    final staging = Directory('${root.path}/staging-${_safe(archive.version)}');
    // A staging directory of another version can't be resumed: drop it.
    if (await root.exists()) {
      await for (final entry in root.list()) {
        if (entry is Directory &&
            entry.path.split('/').last.startsWith('staging-') &&
            entry.path != staging.path) {
          await entry.delete(recursive: true);
        }
      }
    }

    final files = <(OfflineFile, String)>[
      (archive, _archiveName),
      for (final asset in manifest.assets) (asset, asset.path),
    ];
    var done = 0;
    for (final (file, path) in files) {
      final target = File('${staging.path}/$path');
      final before = done;
      await _downloader.download(
        file.url,
        target,
        expectedBytes: file.bytes,
        cancel: cancel,
        onProgress: (received) =>
            onProgress?.call(before + received, manifest.totalBytes),
      );
      if (await sha256OfFile(target) != file.sha256) {
        await target.delete();
        throw ChecksumMismatchException(path);
      }
      done += file.bytes;
    }

    await File(
      '${staging.path}/$_areasName',
    ).writeAsString(jsonEncode(await _api.areas()));
    final points = await _fetchPoints(manifest);
    final config = await _mapApi.config();
    await File(
      '${staging.path}/$_kindsName',
    ).writeAsString(jsonEncode([for (final k in config.kinds) k.toJson()]));

    final finalDir = Directory('${root.path}/${_safe(archive.version)}');
    if (await finalDir.exists()) await finalDir.delete(recursive: true);
    await staging.rename(finalDir.path);

    final now = DateTime.now();
    final row = OfflineMapRow(
      tenantId: tenantId,
      version: archive.version,
      archivePath: '${finalDir.path}/$_archiveName',
      assetsDir: finalDir.path,
      areasPath: '${finalDir.path}/$_areasName',
      bytes: manifest.totalBytes,
      sha256: archive.sha256,
      maxZoom: archive.maxZoom,
      minLng: archive.bounds[0],
      minLat: archive.bounds[1],
      maxLng: archive.bounds[2],
      maxLat: archive.bounds[3],
      labelLanguage: manifest.labelLanguage,
      updateCheckHours: manifest.updateCheckHours,
      downloadedAt: now,
      checkedAt: now,
    );
    await _db.transaction(() async {
      await _db.into(_db.offlineMaps).insertOnConflictUpdate(row);
      await (_db.delete(
        _db.offlinePoints,
      )..where((t) => t.tenantId.equals(tenantId))).go();
      await _db.batch((batch) {
        batch.insertAll(_db.offlinePoints, [
          for (final f in points)
            OfflinePointsCompanion.insert(
              tenantId: tenantId,
              featureId: f.properties.id!,
              featureTenantId: f.properties.tenantId ?? tenantId,
              layer: f.properties.layer,
              kind: Value(f.properties.kind),
              infoKind: Value(f.properties.infoKind),
              nameBn: Value(f.properties.nameBn),
              nameEn: Value(f.properties.nameEn),
              lat: f.lat,
              lng: f.lng,
            ),
        ]);
      });
    });
    // Older versions go now that the new one is live.
    await for (final entry in root.list()) {
      if (entry is Directory && entry.path != finalDir.path) {
        await entry.delete(recursive: true);
      }
    }
    _areasCache.clear();
    return row;
  }

  /// Every point set's features within the archive's bounds, once each.
  Future<List<MapFeature>> _fetchPoints(OfflineMapManifest manifest) async {
    final bounds = manifest.archive!.bounds;
    final byId = <String, MapFeature>{};
    for (final set in manifest.pointSets) {
      await _fetchBox(
        (
          minLng: bounds[0],
          minLat: bounds[1],
          maxLng: bounds[2],
          maxLat: bounds[3],
        ),
        set,
        byId,
        _maxSplits,
      );
    }
    return byId.values.toList();
  }

  /// One box of one point set. The API clips a viewport to its radius and
  /// caps the feature count (`map_viewport_max_radius_km`,
  /// `map_features_max`); a clipped or truncated answer is fetched again as
  /// four quarters, [depth] more times at most.
  Future<void> _fetchBox(
    LatLngBox box,
    OfflinePointSet set,
    Map<String, MapFeature> byId,
    int depth,
  ) async {
    final answer = await _mapApi.features(
      bbox: box,
      zoom: _pointsZoom,
      layers: set.layers.toSet(),
      kinds: set.kinds?.toSet(),
    );
    for (final f in answer.features) {
      final id = f.properties.id;
      if (!f.isCluster && id != null) byId.putIfAbsent(id, () => f);
    }
    if (depth == 0 || !(answer.clipped || answer.truncated)) return;
    final midLng = (box.minLng + box.maxLng) / 2;
    final midLat = (box.minLat + box.maxLat) / 2;
    for (final quarter in [
      (minLng: box.minLng, minLat: box.minLat, maxLng: midLng, maxLat: midLat),
      (minLng: midLng, minLat: box.minLat, maxLng: box.maxLng, maxLat: midLat),
      (minLng: box.minLng, minLat: midLat, maxLng: midLng, maxLat: box.maxLat),
      (minLng: midLng, minLat: midLat, maxLng: box.maxLng, maxLat: box.maxLat),
    ]) {
      await _fetchBox(quarter, set, byId, depth - 1);
    }
  }

  /// When a newer version was last looked for.
  Future<void> markChecked(String tenantId) =>
      (_db.update(_db.offlineMaps)..where((t) => t.tenantId.equals(tenantId)))
          .write(OfflineMapsCompanion(checkedAt: Value(DateTime.now())));

  /// The files, the rows and any half-finished download.
  Future<void> delete(String tenantId) async {
    await _db.transaction(() async {
      await (_db.delete(
        _db.offlineMaps,
      )..where((t) => t.tenantId.equals(tenantId))).go();
      await (_db.delete(
        _db.offlinePoints,
      )..where((t) => t.tenantId.equals(tenantId))).go();
    });
    final root = await _tenantDir(tenantId);
    if (await root.exists()) await root.delete(recursive: true);
    _areasCache.clear();
  }

  static String _safe(String version) =>
      version.toLowerCase().replaceAll(RegExp('[^a-z0-9-]'), '-');
}

final offlineMapRepositoryProvider = Provider<OfflineMapRepository>(
  (ref) => OfflineMapRepository(
    db: ref.watch(appDatabaseProvider),
    api: ref.watch(offlineMapApiProvider),
    mapApi: ref.watch(mapApiProvider),
    downloader: ref.watch(fileDownloaderProvider),
    supportDir: getApplicationSupportDirectory,
  ),
);

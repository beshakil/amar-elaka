// Real sockets and files: slower than widget tests on a loaded runner.
@Timeout(Duration(minutes: 2))
library;

import 'dart:io';

import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/features/offline_map/data/file_downloader.dart';
import 'package:amar_elaka_app/features/offline_map/data/offline_map_repository.dart';
import 'package:amar_elaka_app/features/offline_map/domain/offline_areas.dart';
import 'package:amar_elaka_app/features/offline_map/domain/offline_points.dart';
import 'package:flutter_test/flutter_test.dart';

import '../post/post_test_harness.dart' show memoryDatabase;
import 'offline_map_test_support.dart';

/// The downloaded map area (ADR 050) below the UI: the resumable, verified
/// download, the install into files + Drift, the offline area names and the
/// cached points.
void main() {
  group('OfflineAreaIndex', () {
    final index = OfflineAreaIndex.fromGeoJson(testAreasGeoJson());

    test('names a point by its union and upazila, most specific first', () {
      expect(index.label(23.83, 90.36, 'bn'), 'পল্লবী, মিরপুর');
      expect(index.label(23.83, 90.36, 'en'), 'Pallabi, Mirpur');
    });

    test('a hole is not the union; outside every area is null', () {
      expect(index.label(23.815, 90.375, 'bn'), 'মিরপুর');
      expect(index.label(23.70, 90.36, 'bn'), isNull);
    });

    test('skips a malformed feature instead of failing', () {
      final broken = OfflineAreaIndex.fromGeoJson({
        'features': [
          {'properties': <String, dynamic>{}, 'geometry': null},
          ...testAreasGeoJson()['features'] as List,
        ],
      });
      expect(broken.areas, hasLength(2));
    });
  });

  group('offline points', () {
    OfflinePointRow row(String id, double lat, double lng, String? kind) =>
        OfflinePointRow(
          rowId: 0,
          tenantId: 't1',
          featureId: id,
          featureTenantId: 't1',
          layer: 'places',
          kind: kind,
          infoKind: null,
          nameBn: id,
          nameEn: null,
          lat: lat,
          lng: lng,
        );
    final rows = [
      row('in-hospital', 23.80, 90.36, 'hospital'),
      row('in-pharmacy', 23.81, 90.37, 'pharmacy'),
      row('in-unknown', 23.81, 90.37, null),
      row('outside', 23.70, 90.36, 'hospital'),
    ];
    const box = (minLng: 90.30, minLat: 23.75, maxLng: 90.45, maxLat: 23.85);

    test('the viewport and the toggled kinds, as unclustered points', () {
      final all = offlineFeatures(rows, box: box, zoom: 14.6);
      expect(all.features.map((f) => f.id), [
        'in-hospital',
        'in-pharmacy',
        'in-unknown',
      ]);
      expect(all.clustered, isFalse);
      expect(all.zoom, 14);
      final hospitals = offlineFeatures(
        rows,
        box: box,
        zoom: 14,
        kinds: {'hospital'},
      );
      expect(hospitals.features.map((f) => f.id), ['in-hospital']);
    });

    test('haversine: about 900 m across Mirpur 10', () {
      final metres = haversineMeters(23.7556, 90.3747, 23.7629, 90.3787);
      // PostGIS geography says ~907 m for the same pair (map.e2e-spec).
      expect(metres, inInclusiveRange(880, 930));
      expect(haversineMeters(23.8, 90.4, 23.8, 90.4), 0);
    });
  });

  group('FileDownloader', () {
    late Directory dir;
    late TestFileServer server;
    final body = bytesOf(200000);

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('offline-dl-');
      server = await TestFileServer.start({'a.pmtiles': body});
    });

    tearDown(() async {
      await server.close();
      await dir.delete(recursive: true);
    });

    test('resumes a partial file with a Range request', () async {
      final target = File('${dir.path}/a.pmtiles');
      await target.writeAsBytes(body.sublist(0, 50000));
      final progress = <int>[];
      await FileDownloader(testDio()).download(
        server.url('a.pmtiles'),
        target,
        expectedBytes: body.length,
        onProgress: progress.add,
      );
      expect(server.ranges, ['bytes=50000-']);
      expect(sha256Hex(await target.readAsBytes()), sha256Hex(body));
      expect(progress.first, greaterThan(50000));
      expect(progress.last, body.length);
    });

    test('a dropped connection resumes where it stopped', () async {
      server.dropAfter = 70000;
      final target = File('${dir.path}/a.pmtiles');
      await FileDownloader(
        testDio(),
      ).download(server.url('a.pmtiles'), target, expectedBytes: body.length);
      expect(server.ranges.first, isNull);
      expect(server.ranges, hasLength(2));
      expect(server.ranges.last, startsWith('bytes='));
      expect(sha256Hex(await target.readAsBytes()), sha256Hex(body));
    });

    test(
      'a server that ignores the range sends it whole: no duplicated bytes',
      () async {
        server.ignoreRange = true;
        final target = File('${dir.path}/a.pmtiles');
        await target.writeAsBytes(body.sublist(0, 1000));
        await FileDownloader(
          testDio(),
        ).download(server.url('a.pmtiles'), target, expectedBytes: body.length);
        expect(await target.length(), body.length);
        expect(sha256Hex(await target.readAsBytes()), sha256Hex(body));
      },
    );

    test('an already complete file is not downloaded again', () async {
      final target = File('${dir.path}/a.pmtiles');
      await target.writeAsBytes(body);
      await FileDownloader(
        testDio(),
      ).download(server.url('a.pmtiles'), target, expectedBytes: body.length);
      expect(server.ranges, isEmpty);
    });
  });

  group('OfflineMapRepository', () {
    late Directory support;
    late TestFileServer server;
    late AppDatabase db;
    late FakeOfflineMapApi api;
    late FakePointsMapApi mapApi;
    late OfflineMapRepository repo;
    final archive = bytesOf(150000, 3);
    final glyphs = bytesOf(4000, 5);
    final sprite = bytesOf(900, 11);
    final assets = {
      'fonts/Noto Sans Regular/0-255.pbf': glyphs,
      'sprites/v4/light.png': sprite,
    };

    setUp(() async {
      support = await Directory.systemTemp.createTemp('offline-repo-');
      server = await TestFileServer.start({
        'tenants/mirpur-20261001.pmtiles': archive,
        'tenants/mirpur-20261101.pmtiles': bytesOf(120000, 13),
        ...assets,
      });
      db = memoryDatabase();
      api = FakeOfflineMapApi(manifestFor(server, assets: assets));
      mapApi = FakePointsMapApi();
      repo = OfflineMapRepository(
        db: db,
        api: api,
        mapApi: mapApi,
        downloader: FileDownloader(testDio()),
        supportDir: () async => support,
      );
    });

    tearDown(() async {
      await db.close();
      await server.close();
      await support.delete(recursive: true);
    });

    test(
      'installs the archive, fonts, sprites, areas and the essential points',
      () async {
        final progress = <int>[];
        final row = await repo.install(
          't1',
          api.next,
          onProgress: (done, total) => progress.add(done),
        );
        expect(File(row.archivePath).readAsBytesSync(), archive);
        // Kept at the path the style's {fontstack}/{range} asks for.
        expect(
          File(
            '${row.assetsDir}/fonts/Noto Sans Regular/0-255.pbf',
          ).readAsBytesSync(),
          glyphs,
        );
        expect(row.version, '20261001');
        expect(row.bytes, api.next.totalBytes);
        expect(row.labelLanguage, 'bn');
        expect(progress.last, api.next.totalBytes);
        // One request per point set, past the clustering zoom.
        expect(mapApi.queries.map((q) => q.layers), [
          {'info', 'places'},
          {'info'},
          {'landmarks'},
        ]);
        final points = await repo.points('t1');
        // The hospital came back twice: kept once.
        expect(points.map((p) => p.featureId).toSet(), {'h1', 'i1', 'l1'});
        expect(points, hasLength(3));
        expect(
          (await repo.areas('t1'))!.label(23.83, 90.36, 'bn'),
          'পল্লবী, মিরপুর',
        );
        expect(
          (await repo.kinds('t1')).map((k) => k.code),
          contains('hospital'),
        );
        expect(await repo.current('t1'), isNotNull);
      },
    );

    test(
      'a wrong checksum installs nothing and keeps the old version',
      () async {
        final first = await repo.install('t1', api.next);
        final good = manifestFor(server, version: '20261101');
        final bad = OfflineMapManifestCopy.withArchiveSha(good, '0' * 64);
        await expectLater(
          repo.install('t1', bad),
          throwsA(isA<ChecksumMismatchException>()),
        );
        final current = await repo.current('t1');
        expect(current!.version, first.version);
        expect(File(first.archivePath).existsSync(), isTrue);
      },
    );

    test('a new version replaces the old one on disk and in Drift', () async {
      final first = await repo.install('t1', api.next);
      final second = await repo.install(
        't1',
        manifestFor(server, version: '20261101'),
      );
      expect(second.version, '20261101');
      expect(Directory(first.assetsDir).existsSync(), isFalse);
      expect(File(second.archivePath).existsSync(), isTrue);
      expect(await repo.points('t1'), hasLength(3));
    });

    test('delete removes the files, the row and the points', () async {
      final row = await repo.install('t1', api.next);
      await repo.delete('t1');
      expect(await repo.current('t1'), isNull);
      expect(await repo.points('t1'), isEmpty);
      expect(Directory(row.assetsDir).existsSync(), isFalse);
      expect(await repo.areas('t1'), isNull);
    });
  });
}

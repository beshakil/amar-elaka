// Real sockets and files: slower than widget tests on a loaded runner.
@Timeout(Duration(minutes: 2))
library;

import 'dart:async';
import 'dart:io';

import 'package:amar_elaka_app/core/map/map_style.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/network/connectivity_provider.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/features/offline_map/application/offline_map_controller.dart';
import 'package:amar_elaka_app/features/offline_map/application/offline_map_prefs.dart';
import 'package:amar_elaka_app/features/offline_map/application/offline_map_source.dart';
import 'package:amar_elaka_app/features/offline_map/data/file_downloader.dart';
import 'package:amar_elaka_app/features/offline_map/data/offline_map_repository.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../post/post_test_harness.dart' show memoryDatabase, testTenant;
import 'offline_map_test_support.dart';

class FakeWifi implements WifiCheck {
  FakeWifi(this.wifi);
  bool wifi;

  @override
  Future<bool> onWifi() async => wifi;
}

/// "এলাকার ম্যাপ ডাউনলোড" (ADR 050) through the controller, over a real
/// download from a local file server into a temp directory + in-memory
/// Drift: check → size, download → installed, the Wi-Fi-only auto-update,
/// errors, and which style source the base map then uses.
void main() {
  late Directory support;
  late TestFileServer server;
  late AppDatabase db;
  late FakeOfflineMapApi api;
  late FakeWifi wifi;
  late StreamController<bool> online;
  late ProviderContainer container;

  setUp(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    // The test binding answers every HTTP request 400; this suite downloads
    // from a real local server.
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    support = await Directory.systemTemp.createTemp('offline-ctl-');
    server = await TestFileServer.start({
      'tenants/mirpur-20261001.pmtiles': bytesOf(90000, 3),
      'tenants/mirpur-20261101.pmtiles': bytesOf(80000, 13),
      'sprites/v4/light.json': bytesOf(300, 5),
    });
    db = memoryDatabase();
    api = FakeOfflineMapApi(
      manifestFor(
        server,
        assets: {
          'sprites/v4/light.json': server.files['sprites/v4/light.json']!,
        },
      ),
    );
    wifi = FakeWifi(true);
    online = StreamController<bool>.broadcast();
    container = ProviderContainer(
      overrides: [
        currentTenantConfigProvider.overrideWithValue(testTenant),
        offlineMapRepositoryProvider.overrideWithValue(
          OfflineMapRepository(
            db: db,
            api: api,
            mapApi: FakePointsMapApi(),
            downloader: FileDownloader(Dio()),
            supportDir: () async => support,
          ),
        ),
        wifiCheckProvider.overrideWithValue(wifi),
        isOnlineProvider.overrideWith((ref) => online.stream),
      ],
    );
    // Keep the controller alive between calls.
    container.listen(offlineMapControllerProvider, (_, _) {});
  });

  tearDown(() async {
    container.dispose();
    await online.close();
    await db.close();
    await server.close();
    await support.delete(recursive: true);
  });

  OfflineMapController controller() =>
      container.read(offlineMapControllerProvider.notifier);
  OfflineMapState state() => container.read(offlineMapControllerProvider);

  test('check shows the size first; download installs it', () async {
    await controller().check();
    expect(state().manifest!.totalBytes, 90300);
    expect(state().installed, isNull);
    final progress = <double>[];
    container.listen(
      offlineMapControllerProvider,
      (_, next) => progress.add(next.progress),
    );
    await controller().download();
    expect(state().phase, OfflineMapPhase.idle);
    expect(state().error, isNull);
    expect(state().installed!.version, '20261001');
    expect(state().updateAvailable, isFalse);
    expect(progress.last, 1.0);
  });

  test('no network: a network error, nothing installed', () async {
    api.error = const NetworkException();
    await controller().download();
    expect(state().phase, OfflineMapPhase.failed);
    expect(state().error, OfflineMapError.network);
    expect(state().installed, isNull);
  });

  test('a file over offline_map_max_mb: says it is too large', () async {
    api.next = FakeOfflineMapRepository.tooLarge;
    await controller().check();
    expect(state().error, OfflineMapError.tooLarge);
  });

  test('a newer version: downloaded by itself on Wi-Fi when due', () async {
    await controller().download();
    api.next = manifestFor(server, version: '20261101');
    // Not due yet: doesn't even ask.
    final asked = api.manifestCalls;
    await controller().maybeAutoUpdate();
    expect(api.manifestCalls, asked);
    await controller().maybeAutoUpdate(
      now: DateTime.now().add(const Duration(hours: 25)),
    );
    expect(state().installed!.version, '20261101');
    expect(state().updateAvailable, isFalse);
  });

  test(
    'a newer version on mobile data, or with the switch off: only a notice',
    () async {
      await controller().download();
      api.next = manifestFor(server, version: '20261101');
      final later = DateTime.now().add(const Duration(hours: 25));
      wifi.wifi = false;
      await controller().maybeAutoUpdate(now: later);
      expect(state().installed!.version, '20261001');
      expect(state().updateAvailable, isTrue);

      wifi.wifi = true;
      await container
          .read(offlineMapPrefsProvider.notifier)
          .setAutoUpdateOnWifi(false);
      await controller().maybeAutoUpdate(
        now: later.add(const Duration(hours: 25)),
      );
      expect(state().installed!.version, '20261001');
      expect(state().updateAvailable, isTrue);
    },
  );

  test('delete forgets the map', () async {
    await controller().download();
    await controller().delete();
    expect(state().installed, isNull);
    expect(
      await container.read(offlineMapRepositoryProvider).current('t1'),
      isNull,
    );
  });

  test('the base map: the downloaded file when preferred or offline', () async {
    final source = container.listen(localMapSourceProvider, (_, _) {});
    final installed = container.listen(installedOfflineMapProvider, (_, _) {});
    online.add(true);
    await controller().download();
    await pumpEventQueue();
    expect(installed.read().value, isNotNull);
    await container.read(offlineMapPrefsProvider.future);
    // Preferred (the default): local even online.
    expect(source.read(), isNotNull);
    expect(source.read()!.tilesUrl, startsWith('file:///'));
    expect(source.read()!.tilesUrl, endsWith('/archive.pmtiles'));

    // Switched off: the server's map while online, the phone's offline.
    await container
        .read(offlineMapPrefsProvider.notifier)
        .setUseDownloadedMap(false);
    expect(source.read(), isNull);
    online.add(false);
    await pumpEventQueue();
    expect(source.read(), isNotNull);
  });

  test('the local style points MapLibre at files on the phone', () {
    final local = LocalMapSource.of(installedRow());
    final style = MapStyles.resolve(
      '{"sources":{"protomaps":{"type":"vector","url":"pmtiles://__TILES__"}},'
      '"glyphs":"__ASSETS__/fonts/{fontstack}/{range}.pbf",'
      '"sprite":"__ASSETS__/sprites/v4/light","layers":[]}',
      const {'bn': 'name:bn', 'en': 'name:en'},
      tilesUrl: local.tilesUrl,
      assetsBaseUrl: local.assetsBaseUrl,
      labelLanguage: local.labelLanguage,
    );
    expect(
      style,
      contains(
        'pmtiles://file:///data/offline_map/t1/20261001/archive.pmtiles',
      ),
    );
    expect(
      style,
      contains(
        'file:///data/offline_map/t1/20261001/fonts/{fontstack}/{range}.pbf',
      ),
    );
    expect(
      style,
      contains('file:///data/offline_map/t1/20261001/sprites/v4/light'),
    );
  });
}

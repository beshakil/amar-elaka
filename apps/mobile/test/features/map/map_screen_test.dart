import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/map/base_map.dart';
import 'package:amar_elaka_app/core/map/map_config_provider.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/network/connectivity_provider.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/core/platform/external_apps.dart';
import 'package:amar_elaka_app/features/map/presentation/map_screen.dart';
import 'package:amar_elaka_app/features/offline_map/data/offline_map_repository.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../core/map/map_test_support.dart';
import '../offline_map/offline_map_test_support.dart';
import '../post/post_test_harness.dart' show FakeLocationService, testTenant;

/// The Map tab (ADR 046) without the native map (no platform view in widget
/// tests): the camera is driven through MapScreenController.

const _user = (lat: 23.8069, lng: 90.3687);
const _hospitalId = 'place-hospital';

MapFeature _point(
  String layer,
  String id,
  double lng,
  double lat, {
  String? kind,
  String? nameBn,
  String? price,
  bool? openNow,
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
    price: price,
    openNow: openNow,
  ),
);

class FakeMapApi implements MapApi {
  final featureQueries =
      <({LatLngBox bbox, double zoom, Set<String>? kinds, bool openNow})>[];
  final previews = <String>[];
  var routeCalls = 0;
  var distanceCalls = 0;

  /// Thrown by every call (no network) until cleared.
  AppException? error;

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
    if (error case final e?) throw e;
    featureQueries.add((
      bbox: bbox,
      zoom: zoom,
      kinds: kinds == null ? null : {...kinds},
      openNow: openNow,
    ));
    final all = [
      const MapFeature(
        geometry: MapPointGeometry(coordinates: [90.37, 23.81]),
        properties: MapFeatureProperties(
          cluster: true,
          layer: 'posts',
          kind: 'listings',
          count: 12,
          expansionZoom: 15,
        ),
      ),
      _point(
        'places',
        _hospitalId,
        90.369,
        23.807,
        kind: 'hospital',
        nameBn: 'মিরপুর জেনারেল হাসপাতাল',
        openNow: true,
      ),
      _point(
        'posts',
        'post-1',
        90.3687,
        23.8069,
        kind: 'listings',
        nameBn: 'আইফোন ১৩',
        price: '65000.00',
      ),
    ];
    return MapFeatures(
      zoom: zoom.floor(),
      layers: const ['posts', 'stores', 'places', 'landmarks', 'info'],
      clustered: true,
      clipped: false,
      truncated: false,
      openNowSkipped: const [],
      features: [
        for (final f in all)
          if (kinds == null || kinds.contains(f.properties.kind)) f,
      ],
    );
  }

  @override
  Future<MapPreview> preview({
    required String layer,
    required String id,
    required String tenantId,
  }) async {
    if (error case final e?) throw e;
    previews.add('$layer/$id');
    return MapPreview(
      layer: layer,
      id: id,
      tenantId: tenantId,
      name: const MapName(bn: 'মিরপুর জেনারেল হাসপাতাল', en: 'Mirpur General'),
      photo: null,
      phones: layer == 'posts' ? const [] : const ['+8801799300555'],
      address: 'রোড ৫, মিরপুর ১০',
    );
  }

  @override
  Future<MapDistance> distance({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
  }) async {
    if (error case final e?) throw e;
    distanceCalls++;
    return const MapDistance(straightLineMeters: 871.4);
  }

  @override
  Future<RouteAnswer> route({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
    required String mode,
  }) async {
    if (error case final e?) throw e;
    routeCalls++;
    return RouteAnswer(
      mode: mode,
      distanceMeters: 1971,
      durationSeconds: 1782,
      polyline: null,
      source: 'barikoi',
      degraded: false,
    );
  }
}

/// What would have opened outside the app; Google Maps installed or not.
class FakeApps implements ExternalApps {
  FakeApps({this.googleMaps = true});

  bool googleMaps;
  final opened = <Uri>[];

  @override
  Future<bool> canOpen(Uri uri) async =>
      uri.scheme != 'google.navigation' || googleMaps;

  @override
  Future<bool> open(Uri uri) async {
    if (!await canOpen(uri)) return false;
    opened.add(uri);
    return true;
  }

  @override
  Future<void> share(String text) async {}
}

class MapHarness {
  MapHarness(this.api, this.apps, this.controller);
  final FakeMapApi api;
  final FakeApps apps;
  final MapScreenController controller;
}

Future<MapHarness> pumpMap(
  WidgetTester tester, {
  LocationService? location,
  FakeApps? apps,
  FakeOfflineMapRepository? offline,
  AppException? networkError,
  bool online = true,
}) async {
  final harness = MapHarness(
    FakeMapApi()..error = networkError,
    apps ?? FakeApps(),
    MapScreenController(),
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        mapApiProvider.overrideWithValue(harness.api),
        isOnlineProvider.overrideWith((ref) => Stream.value(online)),
        offlineMapRepositoryProvider.overrideWithValue(
          offline ?? FakeOfflineMapRepository(),
        ),
        mapConfigProvider.overrideWith((ref) async => testMapConfig),
        externalAppsProvider.overrideWithValue(harness.apps),
        baseMapEnabledProvider.overrideWithValue(false),
        currentTenantConfigProvider.overrideWithValue(testTenant),
        locationServiceProvider.overrideWithValue(
          location ?? FakeLocationService(),
        ),
      ],
      child: MaterialApp(
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: MapScreen(controller: harness.controller)),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return harness;
}

bool _contains(LatLngBox box, ({double lat, double lng}) p) =>
    box.minLng < p.lng &&
    p.lng < box.maxLng &&
    box.minLat < p.lat &&
    p.lat < box.maxLat;

LatLngBox _shift(LatLngBox box, double fraction) {
  final dx = (box.maxLng - box.minLng) * fraction;
  return (
    minLng: box.minLng + dx,
    minLat: box.minLat,
    maxLng: box.maxLng + dx,
    maxLat: box.maxLat,
  );
}

Future<void> openList(WidgetTester tester) async {
  await tester.tap(find.text('তালিকা'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('opens at the user and asks for every map_kinds toggle', (
    tester,
  ) async {
    final h = await pumpMap(tester);
    final last = h.api.featureQueries.last;
    expect(_contains(last.bbox, _user), isTrue);
    expect(last.kinds, {
      'hospital',
      'pharmacy',
      'food',
      'gas',
      'bank',
      'bus_stand',
      'shops',
      'listings',
    });
    expect(last.openNow, isFalse);
  });

  testWidgets('without location permission it opens at the area centre', (
    tester,
  ) async {
    final h = await pumpMap(
      tester,
      location: FakeLocationService(const LocationDenied()),
    );
    final centre = testTenant.mapCenter;
    expect(h.api.featureQueries, hasLength(greaterThanOrEqualTo(1)));
    expect(
      _contains(h.api.featureQueries.last.bbox, (
        lat: centre.lat,
        lng: centre.lng,
      )),
      isTrue,
    );
  });

  testWidgets(
    'panning never refetches; past map_search_area_move_ratio it offers "এই এলাকায় খুঁজুন"',
    (tester) async {
      final h = await pumpMap(tester);
      final fetched = h.api.featureQueries.length;
      final box = h.api.featureQueries.last.bbox;
      final zoom = h.api.featureQueries.last.zoom;

      // A small pan (under 0.3 of the viewport): nothing.
      h.controller.cameraIdle(_shift(box, 0.1), zoom);
      await tester.pumpAndSettle();
      expect(find.text('এই এলাকায় খুঁজুন'), findsNothing);

      // Far enough: the button, still no request.
      final moved = _shift(box, 0.5);
      h.controller.cameraIdle(moved, zoom);
      await tester.pumpAndSettle();
      expect(find.text('এই এলাকায় খুঁজুন'), findsOneWidget);
      expect(h.api.featureQueries, hasLength(fetched));

      await tester.tap(find.text('এই এলাকায় খুঁজুন'));
      await tester.pumpAndSettle();
      expect(h.api.featureQueries, hasLength(fetched + 1));
      expect(h.api.featureQueries.last.bbox, moved);
      expect(find.text('এই এলাকায় খুঁজুন'), findsNothing);

      // Another zoom level is another question too.
      h.controller.cameraIdle(moved, zoom + 1);
      await tester.pumpAndSettle();
      expect(find.text('এই এলাকায় খুঁজুন'), findsOneWidget);
    },
  );

  testWidgets('the layer sheet: icons per kind; a change asks again', (
    tester,
  ) async {
    final h = await pumpMap(tester);
    await tester.tap(find.byKey(const ValueKey('map-layers')));
    await tester.pumpAndSettle();
    expect(find.text('ম্যাপে কী দেখাবেন'), findsOneWidget);
    for (final label in [
      'হাসপাতাল',
      'ফার্মেসি',
      'খাবার',
      'গ্যাস',
      'ব্যাংক ও এটিএম',
      'বাস স্ট্যান্ড',
      'দোকান',
      'বিজ্ঞাপন',
    ]) {
      expect(find.widgetWithText(FilterChip, label), findsOneWidget);
    }
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('map-kind-hospital')),
        matching: find.byIcon(Icons.local_hospital),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('map-kind-listings')));
    await tester.tap(find.byKey(const ValueKey('map-open-now')));
    await tester.tap(find.byKey(const ValueKey('map-layers-apply')));
    await tester.pumpAndSettle();
    final last = h.api.featureQueries.last;
    expect(last.kinds!.contains('listings'), isFalse);
    expect(last.kinds!.contains('hospital'), isTrue);
    expect(last.openNow, isTrue);
    await openList(tester);
    expect(find.text('আইফোন ১৩'), findsNothing);
  });

  testWidgets(
    'list = the same results, nearest first; a cluster zooms in and asks again',
    (tester) async {
      final h = await pumpMap(tester);
      await openList(tester);
      final titles = tester
          .widgetList<ListTile>(find.byType(ListTile))
          .map((t) => (t.title! as Text).data)
          .toList();
      // From the user (on the post): the post, the hospital, then the cluster.
      expect(titles, [
        'আইফোন ১৩',
        'মিরপুর জেনারেল হাসপাতাল',
        '১২টি বিজ্ঞাপন — কাছ থেকে দেখুন',
      ]);
      final before = h.api.featureQueries.length;
      await tester.tap(find.text('১২টি বিজ্ঞাপন — কাছ থেকে দেখুন'));
      await tester.pumpAndSettle();
      expect(h.api.featureQueries, hasLength(before + 1));
      expect(h.api.featureQueries.last.zoom, 15);
    },
  );

  testWidgets(
    'a pin opens its preview; "রাস্তায় কত দূর?" asks once per session; directions hand off',
    (tester) async {
      final h = await pumpMap(tester, apps: FakeApps(googleMaps: false));
      await openList(tester);
      await tester.tap(find.text('মিরপুর জেনারেল হাসপাতাল'));
      await tester.pumpAndSettle();
      expect(h.api.previews, ['places/$_hospitalId']);
      expect(find.byKey(const ValueKey('map-preview')), findsOneWidget);
      expect(find.text('সোজা দূরত্ব ৮৭১ মিটার'), findsOneWidget);
      expect(find.text('এখন খোলা আছে'), findsOneWidget);
      expect(find.text('রোড ৫, মিরপুর ১০'), findsOneWidget);
      expect(h.api.routeCalls, 0);

      await tester.tap(find.byKey(const ValueKey('map-preview-road')));
      await tester.pumpAndSettle();
      expect(h.api.routeCalls, 1);
      expect(find.text('২ কিমি · প্রায় ৩০ মিনিট'), findsOneWidget);
      expect(find.byKey(const ValueKey('barikoi-attribution')), findsOneWidget);

      // Google Maps not installed: the browser link, coordinates only.
      await tester.tap(find.byKey(const ValueKey('map-preview-directions')));
      await tester.pumpAndSettle();
      expect(
        h.apps.opened.single.toString(),
        'https://www.google.com/maps/dir/?api=1&destination=23.807%2C90.369',
      );

      // Call: the place's public number, straight to the dialer.
      await tester.tap(find.byKey(const ValueKey('map-preview-call')));
      await tester.pumpAndSettle();
      expect(h.apps.opened.last, Uri(scheme: 'tel', path: '+8801799300555'));

      // Closed and opened again: the road is remembered — no second call.
      Navigator.of(
        tester.element(find.byKey(const ValueKey('map-preview'))),
      ).pop();
      await tester.pumpAndSettle();
      await tester.tap(find.text('মিরপুর জেনারেল হাসপাতাল'));
      await tester.pumpAndSettle();
      expect(find.text('২ কিমি · প্রায় ৩০ মিনিট'), findsOneWidget);
      expect(h.api.routeCalls, 1);
    },
  );

  testWidgets('with Google Maps installed, directions open it', (tester) async {
    final h = await pumpMap(tester);
    await openList(tester);
    await tester.tap(find.text('মিরপুর জেনারেল হাসপাতাল'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('map-preview-directions')));
    await tester.pumpAndSettle();
    expect(
      h.apps.opened.single,
      Uri.parse('google.navigation:q=23.807,90.369'),
    );
  });

  testWidgets(
    'a place can be reported or corrected from its preview; a post cannot',
    (tester) async {
      await pumpMap(tester);
      await openList(tester);
      await tester.tap(find.text('মিরপুর জেনারেল হাসপাতাল'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('map-preview-report')), findsOneWidget);
      expect(find.byKey(const ValueKey('map-preview-suggest')), findsOneWidget);
      Navigator.of(
        tester.element(find.byKey(const ValueKey('map-preview'))),
      ).pop();
      await tester.pumpAndSettle();
      await tester.tap(find.text('আইফোন ১৩'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('map-preview-report')), findsNothing);
      expect(find.byKey(const ValueKey('map-preview-suggest')), findsNothing);
    },
  );

  group('offline (ADR 050)', () {
    OfflinePointRow cached(String id, double lng, double lat, String kind) =>
        OfflinePointRow(
          rowId: 0,
          tenantId: 't1',
          featureId: id,
          featureTenantId: 't1',
          layer: 'places',
          kind: kind,
          infoKind: null,
          nameBn: id == 'h1' ? 'মিরপুর জেনারেল হাসপাতাল' : 'লাজ ফার্মা',
          nameEn: null,
          lat: lat,
          lng: lng,
        );

    FakeOfflineMapRepository downloaded() => FakeOfflineMapRepository(
      row: installedRow(),
      pointRows: [
        cached('h1', 90.369, 23.807, 'hospital'),
        cached('p1', 90.3688, 23.8068, 'pharmacy'),
        // Far outside the viewport: not shown.
        cached('far', 90.6, 24.2, 'hospital'),
      ],
      kindList: testMapConfig.kinds,
    );

    testWidgets(
      'no network with the area downloaded: the cached points, with a notice',
      (tester) async {
        await pumpMap(
          tester,
          offline: downloaded(),
          networkError: const NetworkException(),
          online: false,
        );
        expect(
          find.text(
            'ইন্টারনেট নেই — ডাউনলোড করা ম্যাপ আর জরুরি জায়গাগুলো দেখানো হচ্ছে',
          ),
          findsOneWidget,
        );
        expect(find.text(_l10nBn.mapLoadFailed), findsNothing);
        await openList(tester);
        expect(find.text('মিরপুর জেনারেল হাসপাতাল'), findsOneWidget);
        expect(find.text('লাজ ফার্মা'), findsOneWidget);
        expect(find.byType(ListTile), findsNWidgets(2));
      },
    );

    testWidgets('no network and nothing downloaded: the plain failure', (
      tester,
    ) async {
      await pumpMap(tester, networkError: const NetworkException());
      expect(find.text(_l10nBn.mapLoadFailed), findsOneWidget);
      expect(find.text(_l10nBn.mapOfflinePoints), findsNothing);
    });

    testWidgets(
      'the preview offline: the straight line from the phone, the road says it needs internet',
      (tester) async {
        final h = await pumpMap(
          tester,
          offline: downloaded(),
          networkError: const NetworkException(),
          online: false,
        );
        await openList(tester);
        await tester.tap(find.text('মিরপুর জেনারেল হাসপাতাল'));
        await tester.pumpAndSettle();
        // Haversine from the user (23.8069, 90.3687) to the hospital: ~33 m.
        expect(find.textContaining('সোজা দূরত্ব'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('map-preview-road')));
        await tester.pumpAndSettle();
        expect(find.text(_l10nBn.mapRouteOffline), findsOneWidget);
        expect(h.api.routeCalls, 0);
      },
    );
  });
}

final _l10nBn = lookupAppLocalizations(const Locale('bn'));

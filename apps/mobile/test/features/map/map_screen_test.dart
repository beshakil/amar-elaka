import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/map/base_map.dart';
import 'package:amar_elaka_app/core/map/map_config_provider.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/map/presentation/map_screen.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../post/post_test_harness.dart' show FakeLocationService, testTenant;

/// The area map (ADR 044, 045) without the native map (no platform view in
/// widget tests): the viewport around the area is asked for on open, the list
/// gives clusters and points, a point's card routes only on a tap.
MapFeature _point(
  String layer,
  String id,
  double lng,
  double lat, {
  String? nameBn,
  String? nameEn,
  String? price,
  bool? openNow,
}) => MapFeature(
  id: id,
  geometry: MapPointGeometry(coordinates: [lng, lat]),
  properties: MapFeatureProperties(
    cluster: false,
    layer: layer,
    id: id,
    tenantId: 't1',
    nameBn: nameBn,
    nameEn: nameEn,
    price: price,
    openNow: openNow,
  ),
);

class FakeMapApi implements MapApi {
  final featureQueries =
      <({LatLngBox bbox, double zoom, Set<String> layers, bool openNow})>[];
  var routeCalls = 0;
  ApiException? routeError;

  @override
  Future<MapConfig> config() async => const MapConfig(
    tiles: null,
    assetsBaseUrl: 'http://tiles.test/tiles',
    labelLanguage: 'en',
    fallbackStyleUrl: null,
  );

  @override
  Future<MapFeatures> features({
    required LatLngBox bbox,
    required double zoom,
    required Set<String> layers,
    bool openNow = false,
  }) async {
    featureQueries.add((
      bbox: bbox,
      zoom: zoom,
      layers: {...layers},
      openNow: openNow,
    ));
    final all = [
      const MapFeature(
        geometry: MapPointGeometry(coordinates: [90.37, 23.81]),
        properties: MapFeatureProperties(
          cluster: true,
          layer: 'posts',
          count: 12,
          expansionZoom: 14,
        ),
      ),
      _point(
        'posts',
        'post-1',
        90.3687,
        23.8069,
        nameBn: 'আইফোন ১৩',
        price: '65000.00',
      ),
      _point(
        'landmarks',
        'place-1',
        90.366,
        23.805,
        nameBn: 'মিরপুর স্টেডিয়াম',
        nameEn: 'Mirpur Stadium',
        openNow: false,
      ),
      _point(
        'info',
        'info-1',
        90.365,
        23.808,
        nameBn: 'মিরপুর ২৪ ঘণ্টা ফার্মেসি',
        openNow: true,
      ),
    ];
    const noHours = {'posts', 'stores'};
    return MapFeatures(
      zoom: zoom.floor(),
      layers: [...layers],
      clustered: true,
      clipped: false,
      truncated: false,
      openNowSkipped: openNow
          ? layers.where(noHours.contains).toList()
          : const [],
      features: [
        for (final f in all)
          if (layers.contains(f.properties.layer) &&
              !(openNow &&
                  (noHours.contains(f.properties.layer) ||
                      f.properties.openNow == false)))
            f,
      ],
    );
  }

  @override
  Future<RouteAnswer> route({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
    required String mode,
  }) async {
    routeCalls++;
    if (routeError case final error?) throw error;
    return RouteAnswer(
      mode: mode,
      distanceMeters: 1971,
      durationSeconds: 1782,
      polyline: const [
        [90.36, 23.8],
        [90.3687, 23.8069],
      ],
      source: 'barikoi',
      degraded: false,
    );
  }
}

Future<FakeMapApi> pumpMap(
  WidgetTester tester, {
  LocationService? location,
}) async {
  final api = FakeMapApi();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        mapApiProvider.overrideWithValue(api),
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
        home: const Scaffold(body: MapScreen()),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return api;
}

Future<void> openList(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('map-list')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'asks for the viewport around the area, every layer, at the opening zoom',
    (tester) async {
      final api = await pumpMap(tester);
      final query = api.featureQueries.single;
      expect(query.layers, {'posts', 'stores', 'places', 'landmarks', 'info'});
      expect(query.openNow, isFalse);
      expect(query.zoom, 13);
      final center = testTenant.mapCenter;
      expect(query.bbox.minLng, lessThan(center.lng));
      expect(query.bbox.maxLng, greaterThan(center.lng));
      expect(query.bbox.minLat, lessThan(center.lat));
      expect(query.bbox.maxLat, greaterThan(center.lat));
    },
  );

  testWidgets(
    'lists clusters and points; a point opens its card; a route only on a tap',
    (tester) async {
      final api = await pumpMap(tester);
      await openList(tester);
      expect(find.text('১২টি বিজ্ঞাপন — কাছ থেকে দেখুন'), findsOneWidget);
      expect(find.text('মিরপুর স্টেডিয়াম'), findsOneWidget);

      await tester.tap(find.text('আইফোন ১৩'));
      await tester.pumpAndSettle();
      final card = find.byKey(const ValueKey('map-card'));
      expect(
        find.descendant(of: card, matching: find.text('আইফোন ১৩')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: card, matching: find.text('৳ ৬৫,০০০')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: card, matching: find.text('বিস্তারিত দেখুন')),
        findsOneWidget,
      );

      // Opening a card costs nothing: a route is a paid call, asked for by a tap.
      expect(api.routeCalls, 0);
      await tester.tap(find.text('হেঁটে রাস্তা'));
      await tester.pumpAndSettle();
      expect(api.routeCalls, 1);
      expect(find.text('২ কিমি · প্রায় ৩০ মিনিট'), findsOneWidget);
      expect(find.byKey(const ValueKey('barikoi-attribution')), findsOneWidget);
    },
  );

  testWidgets('a landmark has no details link; the layer toggle asks again', (
    tester,
  ) async {
    final api = await pumpMap(tester);
    await openList(tester);
    await tester.tap(find.text('মিরপুর স্টেডিয়াম'));
    await tester.pumpAndSettle();
    final card = find.byKey(const ValueKey('map-card'));
    expect(
      find.descendant(of: card, matching: find.text('ল্যান্ডমার্ক')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: card, matching: find.text('এখন বন্ধ')),
      findsOneWidget,
    );
    expect(find.text('বিস্তারিত দেখুন'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('map-layer-posts')));
    await tester.pumpAndSettle();
    expect(api.featureQueries.last.layers, {
      'stores',
      'places',
      'landmarks',
      'info',
    });
  });

  testWidgets('open now asks again and names the layers without hours', (
    tester,
  ) async {
    final api = await pumpMap(tester);
    await tester.tap(find.byKey(const ValueKey('map-open-now')));
    await tester.pumpAndSettle();
    expect(api.featureQueries.last.openNow, isTrue);
    expect(
      find.text(
        'বিজ্ঞাপন, দোকান-এর খোলার সময় জানা নেই, তাই এখন দেখানো হচ্ছে না',
      ),
      findsOneWidget,
    );
    await openList(tester);
    expect(find.text('মিরপুর স্টেডিয়াম'), findsNothing);
    expect(find.text('মিরপুর ২৪ ঘণ্টা ফার্মেসি'), findsOneWidget);
  });

  test('parses the API\'s GeoJSON (snake_case properties)', () {
    final parsed = MapFeatures.fromJson({
      'type': 'FeatureCollection',
      'zoom': 12,
      'layers': ['posts', 'places'],
      'clustered': true,
      'clipped': false,
      'truncated': false,
      'open_now_skipped': <String>[],
      'features': [
        {
          'type': 'Feature',
          'geometry': {
            'type': 'Point',
            'coordinates': [90.37, 23],
          },
          'properties': {
            'cluster': true,
            'layer': 'posts',
            'count': 7,
            'expansion_zoom': 13,
          },
        },
        {
          'type': 'Feature',
          'id': 'p1',
          'geometry': {
            'type': 'Point',
            'coordinates': [90.36, 23.75],
          },
          'properties': {
            'cluster': false,
            'layer': 'places',
            'id': 'p1',
            'tenant_id': 't1',
            'name_bn': 'লেক',
            'name_en': 'Lake',
            'category_slug': null,
            'price': null,
            'slug': 'lake',
            'info_kind': null,
            'open_now': true,
          },
        },
      ],
    });
    expect(parsed.features.first.isCluster, isTrue);
    expect(parsed.features.first.properties.expansionZoom, 13);
    expect(parsed.features.first.lat, 23.0);
    final place = parsed.features.last;
    expect(place.properties.nameBn, 'লেক');
    expect(place.properties.tenantId, 't1');
    expect(place.properties.openNow, isTrue);
  });

  testWidgets('without location permission, or over the route limit, says so', (
    tester,
  ) async {
    final api = await pumpMap(
      tester,
      location: FakeLocationService(const LocationDenied()),
    );
    await openList(tester);
    await tester.tap(find.text('আইফোন ১৩'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('গাড়িতে রাস্তা'));
    await tester.pumpAndSettle();
    expect(
      find.text('রাস্তা দেখাতে আপনার লোকেশনের অনুমতি দিন'),
      findsOneWidget,
    );
    expect(api.routeCalls, 0);
  });

  testWidgets('a refused route (429) says to try later', (tester) async {
    final api = await pumpMap(tester);
    api.routeError = ApiException(
      const ApiErrorBody(
        statusCode: 429,
        error: 'ROUTE_RATE_LIMITED',
        message: 'Too many route requests',
      ),
    );
    await openList(tester);
    await tester.tap(find.text('আইফোন ১৩'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('হেঁটে রাস্তা'));
    await tester.pumpAndSettle();
    expect(
      find.text('অনেকবার রাস্তা খোঁজা হয়েছে — একটু পরে আবার চেষ্টা করুন'),
      findsOneWidget,
    );
  });
}

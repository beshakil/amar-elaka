import 'package:amar_elaka_api/amar_elaka_api.dart' show ApiErrorBody;
import 'package:amar_elaka_app/core/map/base_map.dart';
import 'package:amar_elaka_app/core/map/geo_api.dart';
import 'package:amar_elaka_app/core/map/location_picker.dart';
import 'package:amar_elaka_app/core/map/map_config_provider.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/offline_map/data/offline_map_repository.dart';
import 'package:amar_elaka_app/features/offline_map/domain/offline_areas.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../features/post/post_test_harness.dart'
    show FakeLocationService, testTenant;
import '../../features/offline_map/offline_map_test_support.dart';
import 'map_test_support.dart';

/// LocationPicker (ADR 046) without the native map: the test drives the
/// camera through the controller, frame by frame, the way MapLibre reports a
/// drag. Geo answers are the API's FakeProvider's.
class PickerProbe {
  PickerProbe(this.geo, this.controller);

  final FakeGeoApi geo;
  final LocationPickerController controller;
  final changes = <PickedLocation>[];
  PickedLocation? confirmed;

  PickedLocation get last => changes.last;
}

const _frame = Duration(milliseconds: 16);
final _debounce = testMapConfig.client.pickerIdleDebounce;

Future<PickerProbe> pumpPicker(
  WidgetTester tester, {
  FakeGeoApi? geo,
  LocationService? location,
  String purpose = 'store_setup',
  FakeOfflineMapRepository? offline,
}) async {
  final picker = PickerProbe(geo ?? FakeGeoApi(), LocationPickerController());
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        geoApiProvider.overrideWithValue(picker.geo),
        offlineMapRepositoryProvider.overrideWithValue(
          offline ?? FakeOfflineMapRepository(),
        ),
        mapConfigProvider.overrideWith((ref) async => testMapConfig),
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
        home: Scaffold(
          body: LocationPicker(
            purpose: purpose,
            controller: picker.controller,
            onChanged: picker.changes.add,
            onConfirm: (picked) => picker.confirmed = picked,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return picker;
}

/// A drag of [frames] frames that comes to rest at [to] (MapLibre reports a
/// move every frame and an idle at the end — sometimes more than one).
Future<void> drag(
  WidgetTester tester,
  LocationPickerController controller,
  GeoPoint to, {
  int frames = 60,
  int idles = 1,
}) async {
  for (var i = 0; i < frames; i++) {
    controller.cameraMoving();
    await tester.pump(_frame);
  }
  for (var i = 0; i < idles; i++) {
    controller.cameraIdle(to);
    await tester.pump(_frame);
  }
}

void main() {
  testWidgets('one reverse call per camera stop — never per frame or per idle', (
    tester,
  ) async {
    final picker = await pumpPicker(tester);
    // Opening at the phone's location is one settled point: one lookup.
    expect(picker.geo.reverseCalls, hasLength(1));
    expect(picker.geo.reverseCalls.single.purpose, 'store_setup');
    picker.geo.reverseCalls.clear();

    const first = (lat: 23.8100, lng: 90.3700);
    await drag(tester, picker.controller, first, idles: 3);
    // Still inside geo_picker_idle_debounce_ms: nothing yet.
    await tester.pump(_debounce - _frame * 4);
    expect(picker.geo.reverseCalls, isEmpty);
    await tester.pump(_frame * 4);
    expect(picker.geo.reverseCalls, [
      (lat: first.lat, lng: first.lng, purpose: 'store_setup'),
    ]);

    // Stops and starts again before the debounce: only where it finally rests.
    await drag(tester, picker.controller, (lat: 23.82, lng: 90.38));
    await tester.pump(_debounce ~/ 2);
    const second = (lat: 23.8300, lng: 90.3900);
    await drag(tester, picker.controller, second);
    await tester.pump(_debounce);
    await tester.pumpAndSettle();
    expect(picker.geo.reverseCalls.map((c) => (c.lat, c.lng)), [
      (first.lat, first.lng),
      (second.lat, second.lng),
    ]);
    expect(picker.last.point, second);
  });

  testWidgets(
    'shows the area at once and the street when it arrives; the edited text is what is confirmed',
    (tester) async {
      final geo = FakeGeoApi()..reverseDelay = const Duration(seconds: 2);
      final picker = await pumpPicker(tester, geo: geo);
      geo.reverseCalls.clear();

      const point = (lat: 23.8100, lng: 90.3700);
      await drag(tester, picker.controller, point);
      await tester.pump(_debounce);
      await tester.pump();
      // Our own geo_areas: union/upazila, district — before the address.
      expect(find.text('মিরপুর, ঢাকা'), findsOneWidget);
      expect(find.text('ঠিকানা খোঁজা হচ্ছে…'), findsOneWidget);
      expect(find.text('বাড়ি ৮, রোড ২, মিরপুর, ঢাকা'), findsNothing);

      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.text('বাড়ি ৮, রোড ২, মিরপুর, ঢাকা'), findsOneWidget);
      // Barikoi's answer carries its credit.
      expect(find.byKey(const ValueKey('barikoi-attribution')), findsOneWidget);
      expect(picker.last.addressText, 'বাড়ি ৮, রোড ২, মিরপুর, ঢাকা');
      expect(picker.last.areaLabel, 'মিরপুর, ঢাকা');

      await tester.enterText(
        find.descendant(
          of: find.byKey(const ValueKey('location-address')),
          matching: find.byType(TextField),
        ),
        'বাড়ি ৮, রোড ২ (দোতলা), মিরপুর ১০',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('location-confirm')));
      expect(
        picker.confirmed!.addressText,
        'বাড়ি ৮, রোড ২ (দোতলা), মিরপুর ১০',
      );
      expect(picker.confirmed!.point, point);
      expect(geo.reverseCalls, hasLength(1));
    },
  );

  testWidgets('when the geo endpoints fail, the pin and the area are enough', (
    tester,
  ) async {
    final geo = FakeGeoApi()
      ..reverseError = ApiException(
        const ApiErrorBody(
          statusCode: 503,
          error: 'GEO_PROVIDER_UNAVAILABLE',
          message: 'down',
        ),
      );
    final picker = await pumpPicker(tester, geo: geo);
    expect(
      find.text(
        'রাস্তার ঠিকানা পাওয়া যায়নি — পিন আর এলাকার নাম দিয়েই এগোতে পারেন',
      ),
      findsOneWidget,
    );
    expect(find.text('মিরপুর, ঢাকা'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('location-confirm')));
    expect(picker.confirmed!.point, (lat: 23.8069, lng: 90.3687));
    expect(picker.confirmed!.label, 'মিরপুর, ঢাকা');

    // Even our own areas down (offline): the pin alone still confirms.
    geo
      ..areasError = const NetworkException()
      ..reverseError = const NetworkException();
    await drag(tester, picker.controller, (lat: 23.81, lng: 90.37));
    await tester.pump(_debounce);
    await tester.pumpAndSettle();
    expect(
      find.text('ইন্টারনেট নেই — পিন দিয়েই এগোতে পারেন, ঠিকানা পরে লিখে দিন'),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('location-confirm')));
    expect(picker.confirmed!.point, (lat: 23.81, lng: 90.37));
    expect(picker.confirmed!.label, isNull);
  });

  testWidgets(
    'search: minimum length, debounced, our places first; a result costs no reverse call',
    (tester) async {
      final picker = await pumpPicker(tester);
      picker.geo.reverseCalls.clear();
      final box = find.descendant(
        of: find.byKey(const ValueKey('location-search')),
        matching: find.byType(TextField),
      );
      final wait = testMapConfig.client.autocompleteDebounce;

      await tester.enterText(box, 'মি'); // under geocode_autocomplete_min_chars
      await tester.pump(wait * 2);
      expect(picker.geo.autocompleteCalls, isEmpty);

      await tester.enterText(box, 'মিরপু');
      await tester.pump(wait ~/ 2);
      await tester.enterText(box, 'মিরপুর');
      await tester.pump(wait - _frame);
      expect(picker.geo.autocompleteCalls, isEmpty);
      await tester.pump(_frame * 2);
      await tester.pumpAndSettle();
      expect(picker.geo.autocompleteCalls, ['মিরপুর']);

      final titles = tester
          .widgetList<ListTile>(
            find.descendant(
              of: find.byKey(const ValueKey('location-results')),
              matching: find.byType(ListTile),
            ),
          )
          .map((tile) => (tile.title! as Text).data)
          .toList();
      expect(titles, ['মিরপুর স্টেডিয়াম', 'মিরপুর ১০, ঢাকা']);
      expect(find.byKey(const ValueKey('barikoi-attribution')), findsWidgets);

      await tester.tap(find.text('মিরপুর স্টেডিয়াম'));
      await tester.pumpAndSettle();
      expect(picker.geo.reverseCalls, isEmpty);
      expect(picker.last.point, (lat: 23.8066, lng: 90.3634));
      expect(picker.last.addressText, 'মিরপুর স্টেডিয়াম');
    },
  );

  testWidgets('আমার লোকেশন; without permission it starts at the area centre', (
    tester,
  ) async {
    final location = FakeLocationService(const LocationDenied());
    final picker = await pumpPicker(tester, location: location);
    expect(
      find.text(
        'লোকেশনের অনুমতি দেওয়া হয়নি — মানচিত্রে নিজে পিন বসান বা ঠিকানা খুঁজুন',
      ),
      findsOneWidget,
    );
    final centre = testTenant.mapCenter;
    expect(picker.last.point, (lat: centre.lat, lng: centre.lng));

    location.result = const LocationGranted(23.8069, 90.3687);
    await tester.tap(find.byKey(const ValueKey('location-my-location')));
    await tester.pumpAndSettle();
    expect(picker.last.point, (lat: 23.8069, lng: 90.3687));
    expect(picker.geo.reverseCalls, hasLength(2));
  });

  testWidgets(
    'offline with the area downloaded: the area name from the phone; search says it needs internet',
    (tester) async {
      final geo = FakeGeoApi()
        ..areasError = const NetworkException()
        ..reverseError = const NetworkException();
      final picker = await pumpPicker(
        tester,
        geo: geo,
        offline: FakeOfflineMapRepository(
          row: installedRow(),
          areaIndex: OfflineAreaIndex.fromGeoJson(testAreasGeoJson()),
        ),
      );
      await drag(tester, picker.controller, (lat: 23.83, lng: 90.36));
      await tester.pump(_debounce);
      await tester.pumpAndSettle();
      expect(find.text('পল্লবী, মিরপুর'), findsOneWidget);
      expect(
        find.text(
          'ইন্টারনেট নেই — পিন দিয়েই এগোতে পারেন, ঠিকানা পরে লিখে দিন',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('location-confirm')));
      expect(picker.confirmed!.point, (lat: 23.83, lng: 90.36));
      expect(picker.confirmed!.label, 'পল্লবী, মিরপুর');

      await tester.enterText(
        find.descendant(
          of: find.byKey(const ValueKey('location-search')),
          matching: find.byType(TextField),
        ),
        'মিরপুর ১০',
      );
      await tester.pump(testMapConfig.client.autocompleteDebounce);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('location-search-offline')),
        findsOneWidget,
      );
      expect(
        find.text(
          'ইন্টারনেট নেই — ঠিকানা খোঁজা যাচ্ছে না। মানচিত্রে পিন বসিয়ে এগোন',
        ),
        findsOneWidget,
      );
    },
  );
}

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/map/map_config_provider.dart';
import 'package:amar_elaka_app/core/map/location_picker.dart' show GeoPoint;
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/place_feedback/data/place_feedback_api.dart';
import 'package:amar_elaka_app/features/place_feedback/presentation/place_feedback_messages.dart';
import 'package:amar_elaka_app/features/place_feedback/presentation/place_report_sheet.dart';
import 'package:amar_elaka_app/features/place_feedback/presentation/place_suggest_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// "সমস্যা জানান" and "তথ্য সংশোধন" (ADR 051) without a server.
class FakePlaceFeedbackApi implements PlaceFeedbackApi {
  final reports =
      <({String placeId, String reason, String? text, String? duplicateOf})>[];
  final suggestions =
      <
        ({
          GeoPoint? location,
          List<String>? phones,
          List<HoursRange>? hours,
          String? note,
        })
      >[];
  AppException? error;

  @override
  Future<PlaceSnapshot> place(String placeId) async => PlaceSnapshot(
    id: placeId,
    nameBn: 'করিম ফার্মেসি',
    location: (lat: 23.8069, lng: 90.3687),
    phones: const ['+8801766000001'],
    hours: const [
      (day: 6, opens: '09:00', closes: '22:00'),
      // A split shift on Friday: kept as it is unless edited.
      (day: 5, opens: '09:00', closes: '12:00'),
      (day: 5, opens: '15:00', closes: '22:00'),
    ],
  );

  @override
  Future<void> report(
    String placeId,
    String reasonCode,
    String? text, {
    String? duplicateOf,
  }) async {
    if (error case final e?) throw e;
    reports.add((
      placeId: placeId,
      reason: reasonCode,
      text: text,
      duplicateOf: duplicateOf,
    ));
  }

  @override
  Future<void> suggest(
    String placeId, {
    GeoPoint? location,
    List<String>? phones,
    List<HoursRange>? hours,
    String? note,
  }) async {
    if (error case final e?) throw e;
    suggestions.add((
      location: location,
      phones: phones,
      hours: hours,
      note: note,
    ));
  }
}

/// Places around the reported one: itself, one ~25 m off, one ~300 m off.
class FakeNearbyMapApi implements MapApi {
  var calls = 0;

  static MapFeature _place(String id, String name, double lng) => MapFeature(
    id: id,
    geometry: MapPointGeometry(coordinates: [lng, 23.8069]),
    properties: MapFeatureProperties(
      cluster: false,
      layer: 'places',
      id: id,
      tenantId: 't1',
      nameBn: name,
    ),
  );

  @override
  Future<MapFeatures> features({
    required LatLngBox bbox,
    required double zoom,
    Set<String>? layers,
    Set<String>? kinds,
    bool openNow = false,
  }) async {
    calls++;
    return MapFeatures(
      zoom: zoom.floor(),
      layers: const ['places'],
      clustered: false,
      clipped: false,
      truncated: false,
      openNowSkipped: const [],
      features: [
        _place('far', 'দূরের দোকান', 90.3716),
        _place('here', 'করিম ফার্মেসি', 90.3687),
        _place('near', 'করিম ফার্মেসী', 90.36895),
      ],
    );
  }

  @override
  Future<MapConfig> config() => throw UnimplementedError();

  @override
  Future<MapPreview> preview({
    required String layer,
    required String id,
    required String tenantId,
  }) => throw UnimplementedError();

  @override
  Future<MapDistance> distance({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
  }) => throw UnimplementedError();

  @override
  Future<RouteAnswer> route({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
    required String mode,
  }) => throw UnimplementedError();
}

Widget _app(Widget home, FakePlaceFeedbackApi api, {MapApi? maps}) =>
    ProviderScope(
      overrides: [
        placeFeedbackApiProvider.overrideWithValue(api),
        if (maps != null) mapApiProvider.overrideWithValue(maps),
      ],
      child: MaterialApp(
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: home,
      ),
    );

final _l10n = lookupAppLocalizations(const Locale('bn'));

ApiException _api(String code, [Map<String, dynamic>? details]) => ApiException(
  ApiErrorBody(statusCode: 409, error: code, message: code, details: details),
);

void main() {
  Future<void> openSheet(
    WidgetTester tester,
    FakeNearbyMapApi maps,
    void Function(PlaceReport?) onPicked,
  ) async {
    await tester.pumpWidget(
      _app(
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async => onPicked(
                await PlaceReportSheet.show(
                  context,
                  placeId: 'here',
                  location: (lat: 23.8069, lng: 90.3687),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
        FakePlaceFeedbackApi(),
        maps: maps,
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the report sheet: a reason is required; the words are optional',
    (tester) async {
      final maps = FakeNearbyMapApi();
      PlaceReport? picked;
      await openSheet(tester, maps, (p) => picked = p);
      ElevatedButton send() => tester.widget<ElevatedButton>(
        find.descendant(
          of: find.byKey(const ValueKey('place-report-send')),
          matching: find.byType(ElevatedButton),
        ),
      );
      expect(send().onPressed, isNull);
      await tester.tap(
        find.byKey(const ValueKey('place-report-closed_permanently')),
      );
      await tester.enterText(
        find.byKey(const ValueKey('place-report-text')),
        'তালা দেওয়া',
      );
      await tester.pump();
      // Not a duplicate: nobody looks for nearby places.
      expect(maps.calls, 0);
      await tester.tap(find.byKey(const ValueKey('place-report-send')));
      await tester.pumpAndSettle();
      expect(picked, (
        reason: 'closed_permanently',
        text: 'তালা দেওয়া',
        duplicateOf: null,
      ));
    },
  );

  testWidgets(
    '"listed twice": nearby places, nearest first, and which one it is',
    (tester) async {
      // A tall phone: the sheet with its list of places fits on screen.
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final maps = FakeNearbyMapApi();
      PlaceReport? picked;
      await openSheet(tester, maps, (p) => picked = p);
      await tester.tap(find.byKey(const ValueKey('place-report-duplicate')));
      await tester.pumpAndSettle();
      expect(maps.calls, 1);
      // Itself is never offered; the nearer one comes first.
      expect(
        find.byKey(const ValueKey('place-report-twin-here')),
        findsNothing,
      );
      final near = tester.getTopLeft(
        find.byKey(const ValueKey('place-report-twin-near')),
      );
      final far = tester.getTopLeft(
        find.byKey(const ValueKey('place-report-twin-far')),
      );
      expect(near.dy, lessThan(far.dy));
      await tester.tap(find.byKey(const ValueKey('place-report-twin-near')));
      await tester.pump();
      await tester.ensureVisible(
        find.byKey(const ValueKey('place-report-send')),
      );
      await tester.tap(find.byKey(const ValueKey('place-report-send')));
      await tester.pumpAndSettle();
      expect(picked, (reason: 'duplicate', text: '', duplicateOf: 'near'));
    },
  );

  group('the suggest screen', () {
    Future<FakePlaceFeedbackApi> open(WidgetTester tester) async {
      final api = FakePlaceFeedbackApi();
      await tester.pumpWidget(
        _app(const PlaceSuggestScreen(placeId: 'p1'), api),
      );
      await tester.pumpAndSettle();
      return api;
    }

    ElevatedButton sendButton(WidgetTester tester) =>
        tester.widget<ElevatedButton>(
          find.descendant(
            of: find.byKey(const ValueKey('place-suggest-send')),
            matching: find.byType(ElevatedButton),
          ),
        );

    testWidgets(
      'starts from the place as it is; nothing to send until something changes',
      (tester) async {
        await open(tester);
        expect(find.text('করিম ফার্মেসি'), findsOneWidget);
        expect(find.text('01766000001'), findsOneWidget);
        expect(sendButton(tester).onPressed, isNull);
        // The same number written with the country code is no change either.
        await tester.enterText(
          find.byKey(const ValueKey('place-suggest-phones')),
          '+8801766000001',
        );
        await tester.pump();
        expect(sendButton(tester).onPressed, isNull);
      },
    );

    testWidgets('sends only the phones when only the phones changed', (
      tester,
    ) async {
      final api = await open(tester);
      await tester.enterText(
        find.byKey(const ValueKey('place-suggest-phones')),
        '01766000009, 01766000001',
      );
      await tester.enterText(
        find.byKey(const ValueKey('place-suggest-note')),
        'নতুন নম্বর',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('place-suggest-send')));
      await tester.pumpAndSettle();
      final sent = api.suggestions.single;
      expect(sent.location, isNull);
      expect(sent.phones, ['01766000009', '01766000001']);
      expect(sent.hours, isNull);
      expect(sent.note, 'নতুন নম্বর');
    });

    testWidgets('hours: a closed day goes, the untouched split shift stays', (
      tester,
    ) async {
      final api = await open(tester);
      await tester.tap(find.byKey(const ValueKey('place-suggest-edit-hours')));
      await tester.pumpAndSettle();
      final list = find
          .descendant(
            of: find.byKey(const ValueKey('place-suggest')),
            matching: find.byType(Scrollable),
          )
          .first;
      // Turning hours editing on changes nothing yet.
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('place-suggest-send')),
        200,
        scrollable: list,
      );
      expect(sendButton(tester).onPressed, isNull);
      // Saturday: closed from now on.
      final saturday = find.descendant(
        of: find.byKey(const ValueKey('place-suggest-day-6')),
        matching: find.byType(Switch),
      );
      await tester.scrollUntilVisible(saturday, -200, scrollable: list);
      await tester.tap(saturday);
      await tester.pump();
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('place-suggest-send')),
        200,
        scrollable: list,
      );
      await tester.tap(find.byKey(const ValueKey('place-suggest-send')));
      await tester.pumpAndSettle();
      expect(api.suggestions.single.hours, [
        (day: 5, opens: '09:00', closes: '12:00'),
        (day: 5, opens: '15:00', closes: '22:00'),
      ]);
      expect(api.suggestions.single.phones, isNull);
    });

    testWidgets('a refusal is worded, and the screen stays', (tester) async {
      final api = await open(tester);
      api.error = _api('PLACE_SUGGESTION_PENDING_EXISTS');
      await tester.enterText(
        find.byKey(const ValueKey('place-suggest-phones')),
        '01766000008',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('place-suggest-send')));
      await tester.pumpAndSettle();
      expect(find.text(_l10n.placeSuggestPending), findsOneWidget);
      expect(find.byKey(const ValueKey('place-suggest')), findsOneWidget);
    });
  });

  test('every refusal the API gives has its own sentence', () {
    expect(
      placeFeedbackError(_api('PLACE_REPORT_OWN_PLACE'), _l10n, 'bn'),
      _l10n.placeReportOwn,
    );
    expect(
      placeFeedbackError(_api('REPORT_LIMIT_REACHED'), _l10n, 'bn'),
      _l10n.placeFeedbackLimit,
    );
    expect(
      placeFeedbackError(_api('PLACE_SUGGESTION_NO_CHANGE'), _l10n, 'bn'),
      _l10n.placeSuggestNoChange,
    );
    expect(
      placeFeedbackError(
        _api('PLACE_TOO_MANY_PHONES', {'max': 3}),
        _l10n,
        'bn',
      ),
      _l10n.placeSuggestTooManyPhones('৩'),
    );
    expect(
      placeFeedbackError(const NetworkException(), _l10n, 'bn'),
      _l10n.placeFeedbackOffline,
    );
    expect(
      placeFeedbackError(_api('SOMETHING_NEW'), _l10n, 'bn'),
      _l10n.placeFeedbackFailed,
    );
  });
}

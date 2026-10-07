import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/platform/external_apps.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/place_detail/data/place_detail_api.dart';
import 'package:amar_elaka_app/features/place_detail/presentation/place_detail_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../feed/feed_test_harness.dart'
    show FakeExternalApps, GuestAuthController, apiError;
import '../post/post_test_harness.dart' show FakeAuthController;

/// A place's own screen: what it is, open now, its week, call / directions /
/// save, and the report and suggest actions (the screen saved places and
/// place notifications open).

const _placeId = '0191e3a0-0000-7000-8000-00000000a001';

PlaceDetail _place({
  String status = 'published',
  bool possiblyClosed = false,
  List<String> phones = const ['+8801711000001'],
  String? openState = 'open',
  bool withHours = true,
}) => PlaceDetail(
  id: _placeId,
  nameBn: 'রহিম ফার্মেসি',
  nameEn: 'Rahim Pharmacy',
  description: 'সব ধরনের ওষুধ',
  status: status,
  possiblyClosed: possiblyClosed,
  fieldVerified: true,
  claimed: false,
  phones: phones,
  addressText: 'মিরপুর-১০, ঢাকা',
  location: (lat: 23.8069, lng: 90.3687),
  hours: withHours
      ? [
          for (final day in [6, 7, 1, 2, 3, 4])
            (day: day, opens: '09:00', closes: '21:00'),
        ]
      : const [],
  openState: openState,
);

class FakePlaceDetailApi implements PlaceDetailApi {
  FakePlaceDetailApi(this.answer);

  PlaceDetail answer;
  AppException? error;
  bool alreadySaved = false;
  final saved = <String>[];

  @override
  Future<PlaceDetail> place(String placeId) async {
    if (error case final e?) throw e;
    return answer;
  }

  @override
  Future<bool> save(String placeId) async {
    saved.add(placeId);
    return !alreadySaved;
  }
}

final _l10n = lookupAppLocalizations(const Locale('bn'));

Future<FakeExternalApps> _pump(
  WidgetTester tester,
  FakePlaceDetailApi api, {
  bool signedIn = true,
}) async {
  final apps = FakeExternalApps();
  final router = GoRouter(
    initialLocation: '/places/$_placeId',
    routes: [
      GoRoute(
        path: '/places/:id',
        builder: (_, state) =>
            PlaceDetailScreen(placeId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/place-suggest/:id',
        builder: (_, state) => Text('suggest ${state.pathParameters['id']}'),
      ),
      GoRoute(path: '/auth/login', builder: (_, _) => const Text('login')),
    ],
  );
  tester.view.physicalSize = const Size(1080, 2400);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        placeDetailApiProvider.overrideWithValue(api),
        externalAppsProvider.overrideWithValue(apps),
        authControllerProvider.overrideWith(
          signedIn ? FakeAuthController.new : GuestAuthController.new,
        ),
      ],
      child: MaterialApp.router(
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return apps;
}

void main() {
  testWidgets('shows the place, open now, and its week from Saturday', (
    tester,
  ) async {
    await _pump(tester, FakePlaceDetailApi(_place()));

    expect(find.byKey(const ValueKey('place-name')), findsOneWidget);
    expect(find.text('রহিম ফার্মেসি'), findsWidgets);
    expect(find.text(_l10n.placeOpenStateOpen), findsOneWidget);
    expect(find.text(_l10n.placeFieldVerified), findsOneWidget);
    expect(find.text('মিরপুর-১০, ঢাকা'), findsOneWidget);
    // Saturday's hours in Bengali digits; Friday has none, so it's closed.
    expect(find.text('০৯:০০–২১:০০'), findsNWidgets(6));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('place-hours-5')),
        matching: find.text(_l10n.placeSuggestClosed),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('place-closed-banner')), findsNothing);
  });

  testWidgets('a place reported closed says so, and unknown hours say so', (
    tester,
  ) async {
    await _pump(
      tester,
      FakePlaceDetailApi(
        _place(possiblyClosed: true, openState: 'unknown', withHours: false),
      ),
    );
    expect(find.text(_l10n.placePossiblyClosed), findsOneWidget);
    expect(find.text(_l10n.placeOpenStateUnknown), findsOneWidget);
    expect(find.byKey(const ValueKey('place-hours-unknown')), findsOneWidget);
  });

  testWidgets('a permanently closed place shows that, not "possibly"', (
    tester,
  ) async {
    await _pump(
      tester,
      FakePlaceDetailApi(
        _place(status: 'permanently_closed', possiblyClosed: true),
      ),
    );
    expect(find.text(_l10n.placePermanentlyClosed), findsOneWidget);
    expect(find.text(_l10n.placePossiblyClosed), findsNothing);
  });

  testWidgets('call dials the first number; directions hand off to maps', (
    tester,
  ) async {
    final apps = await _pump(tester, FakePlaceDetailApi(_place()));

    await tester.tap(find.byKey(const ValueKey('place-call')));
    await tester.pumpAndSettle();
    expect(apps.opened.first, Uri(scheme: 'tel', path: '+8801711000001'));

    await tester.tap(find.byKey(const ValueKey('place-directions')));
    await tester.pumpAndSettle();
    expect(apps.opened, hasLength(2));
  });

  testWidgets('no number: no call button', (tester) async {
    await _pump(tester, FakePlaceDetailApi(_place(phones: const [])));
    expect(find.byKey(const ValueKey('place-call')), findsNothing);
  });

  testWidgets('save: saved, then already saved', (tester) async {
    final api = FakePlaceDetailApi(_place());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('place-save')));
    await tester.pumpAndSettle();
    expect(api.saved, [_placeId]);
    expect(find.text(_l10n.placeSaved), findsOneWidget);

    api.alreadySaved = true;
    await tester.tap(find.byKey(const ValueKey('place-save')));
    await tester.pumpAndSettle();
    expect(find.text(_l10n.placeAlreadySaved), findsOneWidget);
  });

  testWidgets('a guest is sent to sign in before saving or suggesting', (
    tester,
  ) async {
    final api = FakePlaceDetailApi(_place());
    await _pump(tester, api, signedIn: false);

    await tester.tap(find.byKey(const ValueKey('place-save')));
    await tester.pumpAndSettle();
    expect(api.saved, isEmpty);
    expect(find.text('login'), findsOneWidget);
  });

  testWidgets('suggest opens the suggest screen for this place', (
    tester,
  ) async {
    await _pump(tester, FakePlaceDetailApi(_place()));
    await tester.tap(find.byKey(const ValueKey('place-suggest')));
    await tester.pumpAndSettle();
    expect(find.text('suggest $_placeId'), findsOneWidget);
  });

  testWidgets('gone (404) and failed loads are told apart, with a retry', (
    tester,
  ) async {
    final api = FakePlaceDetailApi(_place())
      ..error = apiError(404, 'PLACE_NOT_FOUND');
    await _pump(tester, api);
    expect(find.text(_l10n.placeNotFound), findsOneWidget);

    api.error = null;
    await tester.tap(find.text(_l10n.placeFeedbackRetry));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('place-name')), findsOneWidget);
  });
}

import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/my_store/application/my_store_providers.dart';
import 'package:amar_elaka_app/features/reviews/data/review_models.dart';
import 'package:amar_elaka_app/features/reviews/data/reviews_api.dart';
import 'package:amar_elaka_app/features/reviews/presentation/review_screens.dart';
import 'package:amar_elaka_app/features/store/data/store_models.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../feed/feed_test_harness.dart' show GuestAuthController;
import '../post/post_test_harness.dart' show FakeAuthController;
import 'review_test_fakes.dart';

const storeId = 's1';

MyStoreSummary _myStore(String role) => MyStoreSummary.fromJson({
  'id': storeId,
  'slug': 'rahim',
  'name': {'bn': 'রহিম স্টোর', 'en': null},
  'status': 'active',
  'role': role,
  'accepted': true,
});

Future<GoRouter> pumpReviews(
  WidgetTester tester,
  FakeReviewsApi api, {
  bool signedIn = true,
  String? myRole,
  String initial = '/',
}) async {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: initial,
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => Scaffold(
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: const [StoreReviewsSection(storeId: storeId)],
          ),
        ),
      ),
      GoRoute(
        path: '${RoutePaths.storeReviews}/:storeId',
        builder: (_, s) =>
            StoreReviewsScreen(storeId: s.pathParameters['storeId']!),
      ),
      GoRoute(
        path: '${RoutePaths.writeReview}/:storeId',
        builder: (_, s) =>
            WriteReviewScreen(storeId: s.pathParameters['storeId']!),
      ),
      GoRoute(
        path: RoutePaths.login,
        builder: (_, _) => const Text('login-screen'),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        reviewsApiProvider.overrideWithValue(api),
        authControllerProvider.overrideWith(
          signedIn ? FakeAuthController.new : GuestAuthController.new,
        ),
        myStoresProvider.overrideWith(
          (ref) async => [if (myRole != null) _myStore(myRole)],
        ),
      ],
      child: MaterialApp.router(
        theme: AppTheme.light(),
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return router;
}

void main() {
  group('on the store page', () {
    testWidgets(
      'the summary, the tier as a word, the newest reviews and a former member',
      (tester) async {
        await pumpReviews(tester, FakeReviewsApi());
        expect(find.byKey(const ValueKey('review-summary')), findsOneWidget);
        expect(find.text('৪.৫'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('seller-tier-trusted')),
          findsOneWidget,
        );
        expect(find.text('বিশ্বস্ত বিক্রেতা'), findsOneWidget);
        expect(find.text('করিম উদ্দিন'), findsOneWidget);
        expect(find.text('সাবেক সদস্য'), findsOneWidget);
        expect(find.text('ধন্যবাদ! আবার আসবেন।'), findsOneWidget);
        expect(find.byKey(const ValueKey('review-write')), findsOneWidget);
      },
    );

    testWidgets('no contact yet: says why, offers no button', (tester) async {
      await pumpReviews(
        tester,
        FakeReviewsApi(
          eligibility: const ReviewEligibility(
            status: EligibilityStatus.noContact,
          ),
        ),
      );
      expect(find.byKey(const ValueKey('review-write')), findsNothing);
      expect(find.textContaining('কল, WhatsApp, SMS বা চ্যাট'), findsOneWidget);
    });

    testWidgets('signed out: asks to sign in', (tester) async {
      await pumpReviews(tester, FakeReviewsApi(), signedIn: false);
      expect(find.byKey(const ValueKey('review-sign-in')), findsOneWidget);
    });

    testWidgets(
      'already reviewed and waiting for a moderator: says so, offers edit',
      (tester) async {
        await pumpReviews(
          tester,
          FakeReviewsApi(
            eligibility: ReviewEligibility.fromJson({
              'status': 'already_reviewed',
              'eligibleAt': null,
              'expiresAt': null,
              'myReview': myReviewJson(status: 'pending'),
            }),
          ),
        );
        expect(find.byKey(const ValueKey('review-mine')), findsOneWidget);
        expect(find.textContaining('যাচাই করা হচ্ছে'), findsOneWidget);
        expect(find.byKey(const ValueKey('review-edit')), findsOneWidget);
      },
    );
  });

  group('writing', () {
    testWidgets('stars, words, sent; a held review says it waits', (
      tester,
    ) async {
      final api = FakeReviewsApi(needsReview: true);
      await pumpReviews(
        tester,
        api,
        initial: RoutePaths.writeReviewFor(storeId),
      );
      expect(
        tester
            .widget<FilledButton>(find.byKey(const ValueKey('review-submit')))
            .onPressed,
        isNull,
        reason: 'no stars yet',
      );
      await tester.tap(find.byKey(const ValueKey('star-4')));
      await tester.enterText(
        find.byKey(const ValueKey('review-text')),
        longBengaliReview,
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('review-submit')));
      await tester.pumpAndSettle();
      expect(api.submitted.single.rating, 4);
      expect(api.submitted.single.text, longBengaliReview);
      expect(find.textContaining('যাচাইয়ের পর'), findsOneWidget);
    });

    testWidgets('too soon: the date it opens, no form', (tester) async {
      await pumpReviews(
        tester,
        FakeReviewsApi(
          eligibility: ReviewEligibility(
            status: EligibilityStatus.tooSoon,
            eligibleAt: DateTime.utc(2026, 10, 12, 10),
          ),
        ),
        initial: RoutePaths.writeReviewFor(storeId),
      );
      expect(find.byKey(const ValueKey('review-blocked')), findsOneWidget);
      expect(find.textContaining('থেকে রিভিউ দিতে পারবেন'), findsOneWidget);
      expect(find.byKey(const ValueKey('review-submit')), findsNothing);
    });

    testWidgets('editing my review: prefilled, saved through edit', (
      tester,
    ) async {
      final api = FakeReviewsApi(
        eligibility: ReviewEligibility.fromJson({
          'status': 'already_reviewed',
          'eligibleAt': null,
          'expiresAt': null,
          'myReview': myReviewJson(rating: 3),
        }),
      );
      await pumpReviews(
        tester,
        api,
        initial: RoutePaths.writeReviewFor(storeId),
      );
      expect(find.text('ভালো দোকান'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('star-5')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('review-submit')));
      await tester.pumpAndSettle();
      expect(api.edited.single.rating, 5);
      expect(api.submitted, isEmpty);
    });

    testWidgets('a refusal from the server is said in Bengali', (tester) async {
      final api = FakeReviewsApi()
        ..failNextWrite = reviewApiError(
          422,
          'REVIEW_TEXT_TOO_LONG',
          details: {'max': 1000},
        );
      await pumpReviews(
        tester,
        api,
        initial: RoutePaths.writeReviewFor(storeId),
      );
      await tester.tap(find.byKey(const ValueKey('star-2')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('review-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('সর্বোচ্চ ১০০০ অক্ষর'), findsOneWidget);
    });
  });

  group('the store side', () {
    testWidgets('the owner replies from the list; nobody gets a delete', (
      tester,
    ) async {
      final api = FakeReviewsApi();
      await pumpReviews(
        tester,
        api,
        myRole: 'owner',
        initial: RoutePaths.storeReviewsFor(storeId),
      );
      await tester.tap(find.byKey(const ValueKey('review-menu-r2')));
      await tester.pumpAndSettle();
      expect(find.text('উত্তর দিন'), findsOneWidget);
      // The menu offers reply and report — never a delete.
      expect(find.byType(PopupMenuItem<String>), findsNWidgets(2));
      await tester.tap(find.text('উত্তর দিন'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('review-reply-input')),
        'আপনার মতামতের জন্য ধন্যবাদ',
      );
      await tester.tap(find.byKey(const ValueKey('review-reply-send')));
      await tester.pumpAndSettle();
      expect(api.replies.single, ('r2', 'আপনার মতামতের জন্য ধন্যবাদ'));
      expect(find.text('আপনার মতামতের জন্য ধন্যবাদ'), findsOneWidget);
      expect(find.textContaining('রিভিউ মুছে ফেলা যায় না'), findsOneWidget);
    });

    testWidgets('anyone else may report, not reply', (tester) async {
      final api = FakeReviewsApi();
      await pumpReviews(
        tester,
        api,
        initial: RoutePaths.storeReviewsFor(storeId),
      );
      await tester.tap(find.byKey(const ValueKey('review-menu-r1')));
      await tester.pumpAndSettle();
      expect(find.text('উত্তর দিন'), findsNothing);
      await tester.tap(find.text('রিপোর্ট করুন'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('review-report-send')));
      await tester.pumpAndSettle();
      expect(api.reports.single, ('r1', 'fake_review'));
    });
  });

  test('a "how was it?" push opens the review form', () {
    expect(
      appRouteForDeepLink('/stores/s9/review'),
      RoutePaths.writeReviewFor('s9'),
    );
    expect(appRouteForDeepLink('/stores/me'), RoutePaths.myStore);
  });

  test('tiers from the API', () {
    expect(sellerTierOf('top'), SellerTier.top);
    expect(sellerTierOf('none'), SellerTier.none);
    expect(sellerTierOf(null), SellerTier.newStore);
  });
}

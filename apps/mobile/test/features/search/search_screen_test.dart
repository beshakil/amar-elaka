import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/search/data/recent_searches_store.dart';
import 'package:amar_elaka_app/features/search/domain/search_request.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../feed/feed_test_harness.dart';
import 'search_test_harness.dart';

void main() {
  group('typing', () {
    testWidgets('asks for suggestions once typing pauses, not per keystroke', (
      tester,
    ) async {
      final app = await pumpSearchApp(tester);
      final field = find.byKey(const ValueKey('search-field'));
      // A Bengali word as an IME builds it: ড, ডা, ডাক, ডাক্, ডাক্ত…
      for (final partial in [
        'ড',
        'ডা',
        'ডাক',
        'ডাক্',
        'ডাক্ত',
        'ডাক্তা',
        'ডাক্তার',
      ]) {
        await tester.enterText(field, partial);
        await tester.pump(const Duration(milliseconds: 50));
      }
      await settleSearch(tester);
      expect(app.search.suggested, ['ডাক্তার']);
      // What was typed is kept exactly as the keyboard composed it.
      expect(find.text('ডাক্তার'), findsWidgets);
    });

    testWidgets('drops an answer for text that has since changed', (
      tester,
    ) async {
      final search = FakeSearchApi()
        ..suggestions = (q) => SuggestResult.fromJson({
          'query': q,
          'categories': <dynamic>[],
          'queries': [
            {'query': 'answer for $q'},
          ],
          'listings': <dynamic>[],
          'degraded': false,
        });
      await pumpSearchApp(tester, search: search);
      await typeQuery(tester, 'bas');
      expect(find.text('answer for bas'), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('search-field')),
        'basa',
      );
      await tester.pump(const Duration(milliseconds: 100));
      // Still typing: the old answer may show, a request for "basa" is not sent yet.
      expect(search.suggested, ['bas']);
      await settleSearch(tester);
      expect(find.text('answer for basa'), findsOneWidget);
    });

    testWidgets(
      'shows recent searches and trending chips before typing; voice is disabled',
      (tester) async {
        final app = await pumpSearchApp(
          tester,
          prefs: {
            'recent_searches.t1': ['iphone 13', 'ডাক্তার'],
          },
        );
        expect(
          find.byKey(const ValueKey('search-recent-iphone 13')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('search-trending-daktar')),
          findsOneWidget,
        );
        final voice = tester.widget<IconButton>(
          find.byKey(const ValueKey('search-voice')),
        );
        expect(voice.onPressed, isNull);

        await tester.tap(find.byKey(const ValueKey('search-trending-daktar')));
        await settleSearch(tester);
        expect(app.search.requests.single.text, 'daktar');
        // Remembered, newest first, per tenant.
        expect(await tester.runAsync(() => RecentSearchesStore('t1').read()), [
          'daktar',
          'iphone 13',
          'ডাক্তার',
        ]);
      },
    );

    testWidgets('a category suggestion opens that category', (tester) async {
      final app = await pumpSearchApp(tester);
      await typeQuery(tester, 'বাসা');
      await tester.tap(
        find.byKey(const ValueKey('search-suggest-category-to-let')),
      );
      await settleSearch(tester);
      expect(app.search.requests.single.categorySlug, 'to-let');
      expect(app.search.requests.single.text, '');
    });
  });

  group('results', () {
    testWidgets('sorts; offers distance only with a location', (tester) async {
      final app = await pumpSearchApp(tester);
      await typeQuery(tester, 'flat');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-sort')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('search-sort-price_asc')));
      await settleSearch(tester);
      expect(app.search.requests.last.sort, SearchSort.priceAsc);
      expect(find.text('দাম: কম থেকে বেশি'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('search-sort')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('search-sort-distance')),
        findsOneWidget,
      );
    });

    testWidgets('no distance sort without a location', (tester) async {
      await pumpSearchApp(tester, located: false);
      await typeQuery(tester, 'flat');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-sort')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('search-sort-distance')), findsNothing);
    });

    testWidgets('opening a result logs the click for this search', (
      tester,
    ) async {
      final app = await pumpSearchApp(tester);
      await typeQuery(tester, 'flat');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-result-h1')));
      await settleSearch(tester);
      expect(app.search.clicks, [('s-1', 'h1')]);
      expect(find.text('detail-h1'), findsOneWidget);
    });
  });

  group('empty state', () {
    SearchResult nothing(SearchRequest r) =>
        searchResult(hits: const [], radiusKm: r.radiusKm ?? 10);

    testWidgets('offers removing each filter, a wider radius, and saving', (
      tester,
    ) async {
      // Results until a filter narrows them to nothing.
      final app = await pumpSearchApp(
        tester,
        search: FakeSearchApi()
          ..respond = (r) => r.hasFilters ? nothing(r) : searchResult(),
      );
      await typeQuery(tester, 'duplex');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-filter-button')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('search-filter-category-to-let')),
      );
      await settleSearch(tester);
      await tester.tap(find.byKey(const ValueKey('search-filter-show')));
      await settleSearch(tester);

      expect(find.byKey(const ValueKey('search-empty')), findsOneWidget);
      expect(find.text('“duplex”-এর জন্য কিছু পাওয়া যায়নি'), findsOneWidget);
      expect(find.text('“টু-লেট / বাসা ভাড়া” ছাড়া খুঁজুন'), findsOneWidget);
      expect(find.text('২০ কিমি পর্যন্ত খুঁজুন'), findsOneWidget);

      await tester.tap(
        find.byKey(const ValueKey('search-empty-remove-category')),
      );
      await settleSearch(tester);
      expect(app.search.requests.last.categorySlug, isNull);
      expect(find.byKey(const ValueKey('search-result-h1')), findsOneWidget);
    });

    testWidgets('widens the radius, and stops offering it at the maximum', (
      tester,
    ) async {
      final search = FakeSearchApi()
        // The server caps the radius at 20 km.
        ..respond = (r) => searchResult(
          hits: const [],
          radiusKm: (r.radiusKm ?? 10) > 20 ? 20 : (r.radiusKm ?? 10),
        );
      final app = await pumpSearchApp(tester, search: search);
      await typeQuery(tester, 'duplex');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-empty-widen')));
      await settleSearch(tester);
      expect(app.search.requests.last.radiusKm, 20);
      expect(find.text('৪০ কিমি পর্যন্ত খুঁজুন'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('search-empty-widen')));
      await settleSearch(tester);
      expect(app.search.requests.last.radiusKm, 40);
      expect(find.byKey(const ValueKey('search-empty-widen')), findsNothing);
    });

    testWidgets('saving asks a guest to sign in first', (tester) async {
      await pumpSearchApp(
        tester,
        signedIn: false,
        search: FakeSearchApi()..respond = nothing,
      );
      await typeQuery(tester, 'duplex');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-empty-save')));
      await settleSearch(tester);
      expect(find.text('login-screen'), findsOneWidget);
    });

    testWidgets('explains the active-search limit', (tester) async {
      final saved = FakeSavedSearchesApi()
        ..createError = apiError(
          409,
          'SAVED_SEARCH_LIMIT_REACHED',
          details: {'maxActive': 5},
        );
      await pumpSearchApp(
        tester,
        saved: saved,
        search: FakeSearchApi()..respond = nothing,
      );
      await typeQuery(tester, 'duplex');
      await submitQuery(tester);
      await tester.tap(find.byKey(const ValueKey('search-empty-save')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('save-search-confirm')));
      await settleSearch(tester);
      expect(
        find.text(
          'একসাথে সর্বোচ্চ ৫টি সার্চ চালু রাখা যায়। একটি বন্ধ করে আবার চেষ্টা করুন।',
        ),
        findsOneWidget,
      );
    });
  });

  group('saved searches', () {
    testWidgets(
      'lists them with the new-results badge; opens the new results',
      (tester) async {
        final saved = FakeSavedSearchesApi()
          ..items = [
            savedSearch(),
            savedSearch(
              id: 'ss2',
              name: 'iphone',
              active: false,
              pausedAt: DateTime.utc(2026, 9, 1),
              newResultCount: 0,
            ),
          ];
        await pumpSearchApp(
          tester,
          saved: saved,
          initialLocation: RoutePaths.savedSearches,
        );
        expect(find.text('১/৫টি চালু'), findsOneWidget);
        expect(find.text('৩'), findsOneWidget); // the badge
        expect(
          find.textContaining('অনেকদিন খোলা হয়নি, তাই বন্ধ'),
          findsOneWidget,
        );

        await tester.tap(find.byKey(const ValueKey('saved-search-ss1')));
        await settleSearch(tester);
        expect(
          find.byKey(const ValueKey('saved-search-result-p7')),
          findsOneWidget,
        );
      },
    );

    testWidgets('pauses, resumes and deletes', (tester) async {
      final app = await pumpSearchApp(
        tester,
        initialLocation: RoutePaths.savedSearches,
      );
      await tester.tap(find.byKey(const ValueKey('saved-search-menu-ss1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('saved-search-toggle-ss1')));
      await settleSearch(tester);
      expect(app.saved.toggles, [('ss1', false)]);
      expect(find.textContaining('বন্ধ আছে'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('saved-search-menu-ss1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('saved-search-toggle-ss1')));
      await settleSearch(tester);
      expect(app.saved.toggles.last, ('ss1', true));

      await tester.tap(find.byKey(const ValueKey('saved-search-menu-ss1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('saved-search-delete-ss1')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('saved-search-delete-confirm')),
      );
      await settleSearch(tester);
      expect(app.saved.deleted, ['ss1']);
      expect(find.text('কোনো সার্চ সেভ করা নেই'), findsOneWidget);
    });
  });

  test('recent searches: newest first, no duplicates, capped', () async {
    SharedPreferences.setMockInitialValues({});
    final store = RecentSearchesStore('t1');
    for (var i = 0; i < 10; i++) {
      await store.add('q$i');
    }
    await store.add('Q3');
    final recent = await store.read();
    expect(recent.first, 'Q3');
    expect(recent, hasLength(RecentSearchesStore.keep));
    expect(recent.where((q) => q.toLowerCase() == 'q3'), hasLength(1));
    expect(await RecentSearchesStore('other').read(), isEmpty);
  });
}

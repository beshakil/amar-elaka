import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/search/domain/search_request.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'search_test_harness.dart';

/// A renter's path: type in Banglish → pick from the suggestions → narrow
/// with the filter sheet (category, price range, a field value — each with
/// its count) → save the search, notified once a day. Runs headless in CI
/// (test/features/search/search_happy_path_test.dart) and on a device
/// (integration_test/search_happy_path_test.dart). The API is faked.
Future<void> runSearchHappyPath(WidgetTester tester) async {
  final app = await pumpSearchApp(tester);

  // Banglish, as typed on a Latin keyboard: suggestions in both scripts.
  await typeQuery(tester, 'basa vara');
  expect(app.search.suggested, ['basa vara']);
  expect(find.text('টু-লেট / বাসা ভাড়া'), findsOneWidget);
  expect(find.text('বাসা ভাড়া'), findsOneWidget);

  // Search it: the same cards as the feed.
  await submitQuery(tester);
  expect(app.search.requests.single.text, 'basa vara');
  expect(find.byKey(const ValueKey('search-result-h1')), findsOneWidget);
  expect(find.text('প্রায় ২টি ফলাফল · ১০ কিমির মধ্যে'), findsOneWidget);

  // The filter sheet: every choice with its count, applied as tapped.
  await tester.tap(find.byKey(const ValueKey('search-filter-button')));
  await tester.pumpAndSettle();
  expect(find.text('টু-লেট / বাসা ভাড়া (১২)'), findsOneWidget);
  await tester.tap(find.byKey(const ValueKey('search-filter-category-to-let')));
  await settleSearch(tester);
  await tester.tap(find.text('৳ ১০,০০০–২০,০০০ (৭)'));
  await settleSearch(tester);
  await tester.tap(find.text('ব্যবহৃত (৫)'));
  await settleSearch(tester);
  await tester.tap(find.byKey(const ValueKey('search-filter-show')));
  await tester.pumpAndSettle();

  final asked = app.search.requests.last;
  expect(asked.text, 'basa vara');
  expect(asked.categorySlug, 'to-let');
  expect((asked.priceMin, asked.priceMax), ('10000.00', '20000.00'));
  expect(asked.queryParameters()['filters'], '{"condition":{"in":["used"]}}');
  // Shown as removable chips.
  expect(find.text('ফিল্টার (৩)'), findsOneWidget);

  // Save it: named after the text, told once a day.
  await tester.tap(find.byKey(const ValueKey('search-save')));
  await tester.pumpAndSettle();
  expect(
    tester
        .widget<TextField>(find.byKey(const ValueKey('save-search-name')))
        .controller!
        .text,
    'basa vara',
  );
  await tester.tap(find.byKey(const ValueKey('save-search-frequency-daily')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('save-search-confirm')));
  await settleSearch(tester);

  final saved = app.saved.created.single;
  expect(saved.name, 'basa vara');
  expect(saved.q, 'basa vara');
  expect(saved.frequency, AlertFrequency.daily);
  expect(saved.radiusKm, 10);
  expect(saved.filters.toRequestJson(), {
    'category': 'to-let',
    'fields': {
      'condition': {
        'in': ['used'],
      },
    },
    'price_min': '10000.00',
    'price_max': '20000.00',
  });
  expect(find.byKey(const ValueKey('search-saved-snackbar')), findsOneWidget);
  expect(SearchSort.values, contains(asked.sort));
}

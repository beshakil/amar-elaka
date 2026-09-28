import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../feed/goldens/feed_golden_test.dart' show decodeImages;
import '../../post/goldens/golden_fonts.dart';
import '../search_test_harness.dart';

/// The search results and the empty state in Bengali, light and dark, with
/// the real font and conjunct-heavy text: a shaping, numeral or layout change
/// shows up as a pixel diff.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/search/goldens
void main() {
  setUpAll(loadAppFonts);

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('results screen, $name', (tester) async {
      final search = FakeSearchApi()
        ..respond = (_) => searchResult(
          total: 128,
          hits: [
            hitJson(title: ConjunctText.title, boosted: true),
            hitJson(
              id: 'h2',
              title: 'মিরপুর ১০-এ দক্ষিণমুখী ফ্ল্যাট, লিফট ও জেনারেটর সহ',
              price: '22000.00',
              distanceMeters: 1900,
            ),
            hitJson(
              id: 'h3',
              title: ConjunctText.brand,
              price: null,
              distanceMeters: 420,
            ),
          ],
        );
      await pumpSearchApp(tester, search: search, theme: theme);
      await typeQuery(tester, 'basa vara');
      await submitQuery(tester);
      await decodeImages(tester);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('search_results_$name.png'),
      );
    });

    testWidgets('empty state, $name', (tester) async {
      final search = FakeSearchApi()
        ..respond = (r) =>
            r.hasFilters ? searchResult(hits: const []) : searchResult();
      await pumpSearchApp(tester, search: search, theme: theme);
      await typeQuery(tester, 'ডুপ্লেক্স বাড়ি');
      await submitQuery(tester);
      // Two filters to offer removing: a category and a price range.
      await tester.tap(find.byKey(const ValueKey('search-filter-button')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('search-filter-category-to-let')),
      );
      await settleSearch(tester);
      await tester.tap(find.byKey(const ValueKey('search-filter-show')));
      await settleSearch(tester);
      expect(find.byKey(const ValueKey('search-empty')), findsOneWidget);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('search_empty_$name.png'),
      );
    });
  }
}

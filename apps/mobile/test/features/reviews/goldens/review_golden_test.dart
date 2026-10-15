import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/features/reviews/data/review_models.dart';
import 'package:amar_elaka_app/features/reviews/presentation/widgets/review_widgets.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../post/goldens/golden_fonts.dart';
import '../review_test_fakes.dart';

/// Goldens for reviews (ADR 061), light and dark: the summary with its
/// histogram and every tier badge; a review with long Bengali that must wrap
/// (conjuncts intact), the store's reply; a mixed Bengali/English one by a
/// scrubbed ("former member") author.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/reviews/goldens
void main() {
  setUpAll(loadAppFonts);

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('reviews, $name', (tester) async {
      tester.view.physicalSize = const Size(1080, 3000);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      final page = reviewPage();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: theme,
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                ReviewSummaryCard(summary: page.summary),
                const SizedBox(height: 8),
                const Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    SellerTierBadge(tier: SellerTier.top),
                    SellerTierBadge(tier: SellerTier.trusted),
                    SellerTierBadge(tier: SellerTier.good),
                    SellerTierBadge(tier: SellerTier.newStore),
                  ],
                ),
                for (final r in page.items)
                  ReviewCard(review: r, onReport: () {}),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(ListView),
        matchesGoldenFile('reviews_$name.png'),
      );
    });
  }
}

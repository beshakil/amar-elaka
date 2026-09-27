import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/tokens/app_spacing.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:amar_elaka_app/features/post/presentation/widgets/post_card.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../post_test_harness.dart';
import 'golden_fonts.dart';

/// Goldens for the post card and the preview screen in Bengali, light and
/// dark, with conjunct-heavy text: a font, shaping or line-height change
/// that breaks Bengali rendering shows up as a pixel diff here.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/post/goldens
void main() {
  setUpAll(loadAppFonts);

  const cardData = PostDisplayData(
    title: ConjunctText.title,
    priceLabel: '৳ ১২,৫০০',
    attributes: ['অবস্থা ব্যবহৃত', 'ব্র্যান্ড ${ConjunctText.brand}'],
    details: [],
    photos: [],
    placeLabel: ConjunctText.place,
    postedLabel: 'আজ',
  );

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('post card, $name', (tester) async {
      tester.view.physicalSize = const Size(1080, 1400);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: theme,
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: ListView(
              padding: const EdgeInsets.all(AppSpacing.md),
              children: const [
                PostCard(data: cardData),
                SizedBox(height: AppSpacing.sm),
                PostCard(
                  data: PostDisplayData(
                    title: ConjunctText.title,
                    priceLabel: null,
                    attributes: [],
                    details: [],
                    photos: [],
                    placeLabel: ConjunctText.place,
                    isSold: true,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await expectLater(
        find.byType(ListView),
        matchesGoldenFile('post_card_$name.png'),
      );
    });

    testWidgets('preview screen, $name', (tester) async {
      final api = FakePostsApi()..addressLabelBn = ConjunctText.place;
      await pumpPostApp(
        tester,
        api: api,
        theme: theme,
        physicalSize: const Size(1080, 5200),
      );
      await walkTo(tester, PostStep.contact, title: ConjunctText.title);
      await tester.enterText(
        find.descendant(
          of: find.byKey(const ValueKey('contact-name')),
          matching: find.byType(TextField),
        ),
        ConjunctText.contact,
      );
      await next(tester);
      expect(find.text('ধাপ ৬/৬: দেখে নিন'), findsOneWidget);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('preview_screen_$name.png'),
      );
    });
  }
}

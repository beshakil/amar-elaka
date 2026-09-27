import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/tokens/app_spacing.dart';
import 'package:amar_elaka_app/core/design/widgets/network_photo.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/feed/presentation/widgets/post_listing_card.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../post/goldens/golden_fonts.dart';
import '../feed_test_harness.dart';

/// The feed card (every state) and the post detail in Bengali, light and
/// dark, with the real font and conjunct-heavy text: a shaping, line-height
/// or layout change shows up as a pixel diff.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/feed/goldens
void main() {
  setUpAll(loadAppFonts);

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('feed cards, $name', (tester) async {
      tester.view.physicalSize = const Size(1080, 1900);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        NetworkPhotoOverride(
          // One photo loaded, the others still on their thumbhash.
          builder: (url, placeholder) =>
              url.contains('p1-') ? loadedPhoto(url, placeholder) : placeholder,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme,
            locale: const Locale('bn'),
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: Scaffold(
              body: ListView(
                padding: const EdgeInsets.all(AppSpacing.md),
                children: [
                  PostListingCard(
                    card: postCard(
                      title: ConjunctText.title,
                      badges: const ['boosted', 'verified_store'],
                      isSaved: true,
                    ),
                    onToggleSaved: () {},
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  PostListingCard(
                    card: postCard(
                      id: 'p2',
                      title: 'স্ট্র্যাটাস আকাঙ্ক্ষা স্মার্টফোন',
                      price: '1250000.00',
                      distanceMeters: 420,
                      badges: const ['negotiable'],
                    ),
                    onToggleSaved: () {},
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  PostListingCard(
                    card: postCard(
                      id: 'p3',
                      title: ConjunctText.brand,
                      isSold: true,
                    ),
                    onToggleSaved: () {},
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  PostListingCard(
                    card: postCard(
                      id: 'p4',
                      title: 'বিনামূল্যে পুরনো বই',
                      price: null,
                      withCover: false,
                      distanceMeters: null,
                      badges: const ['free'],
                    ),
                    onToggleSaved: () {},
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await decodeImages(tester);
      await expectLater(
        find.byType(ListView),
        matchesGoldenFile('feed_cards_$name.png'),
      );
    });

    testWidgets('post detail, $name', (tester) async {
      final engagement = FakeEngagementApi()
        ..details['p1'] = postDetail(
          title: ConjunctText.title,
          description: ConjunctText.description,
          similar: [postCard(id: 'p9', title: ConjunctText.brand)],
        );
      await pumpFeedApp(
        tester,
        engagement: engagement,
        theme: theme,
        initialLocation: RoutePaths.postDetailFor('p1'),
        physicalSize: const Size(1080, 4600),
      );
      await decodeImages(tester);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('post_detail_$name.png'),
      );
    });
  }
}

/// The test engine decodes images only in real async time: decode every
/// image on screen (the thumbhash placeholders) before the snapshot.
Future<void> decodeImages(WidgetTester tester) async {
  await tester.pumpAndSettle();
  final images = tester.widgetList<Image>(find.byType(Image)).toList();
  final context = tester.element(find.byType(Scaffold).first);
  await tester.runAsync(() async {
    for (final image in images) {
      await precacheImage(image.image, context);
    }
  });
  await tester.pumpAndSettle();
}

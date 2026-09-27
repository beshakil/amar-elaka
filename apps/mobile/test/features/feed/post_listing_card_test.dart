import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/network_photo.dart';
import 'package:amar_elaka_app/features/feed/presentation/widgets/post_listing_card.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'feed_test_harness.dart';

/// The feed card in each state it can be in.
void main() {
  Future<void> pumpCard(
    WidgetTester tester,
    FeedPostCard card, {
    VoidCallback? onToggleSaved,
    Widget Function(String, Widget)? photos,
  }) async {
    await tester.pumpWidget(
      NetworkPhotoOverride(
        builder: photos ?? loadedPhoto,
        child: MaterialApp(
          theme: AppTheme.light(),
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: PostListingCard(card: card, onToggleSaved: onToggleSaved),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('price in Bengali numerals, area and distance in km', (
    tester,
  ) async {
    await pumpCard(tester, postCard());
    expect(find.text('আইফোন ১৩, ১২৮ জিবি'), findsOneWidget);
    expect(find.text('৳ ৬৫,০০০'), findsOneWidget);
    expect(find.text('মিরপুর ১০ · ১.২ কিমি দূরে'), findsOneWidget);
  });

  testWidgets('under a kilometre the distance reads in metres', (tester) async {
    await pumpCard(tester, postCard(distanceMeters: 347));
    expect(find.text('মিরপুর ১০ · ৩৫০ মি দূরে'), findsOneWidget);
  });

  testWidgets('no distance (country scope): just the area', (tester) async {
    await pumpCard(tester, postCard(distanceMeters: null));
    expect(find.text('মিরপুর ১০'), findsOneWidget);
  });

  testWidgets('badges: boosted, verified store, negotiable', (tester) async {
    await pumpCard(
      tester,
      postCard(badges: const ['boosted', 'verified_store', 'negotiable']),
    );
    expect(find.text('বুস্টেড'), findsOneWidget);
    expect(find.text('যাচাই করা দোকান'), findsOneWidget);
    expect(find.text('আলোচনা সাপেক্ষে'), findsOneWidget);
  });

  testWidgets('free, and no price at all', (tester) async {
    await pumpCard(tester, postCard(price: null, badges: const ['free']));
    expect(find.text('ফ্রি'), findsOneWidget);
    await pumpCard(tester, postCard(price: null));
    expect(find.text('দাম জানতে যোগাযোগ করুন'), findsOneWidget);
  });

  testWidgets('sold: a band across the photo and a badge', (tester) async {
    await pumpCard(tester, postCard(isSold: true));
    expect(find.text('বিক্রি হয়েছে'), findsNWidgets(2));
  });

  testWidgets('the thumbhash shows while the photo loads, then the photo', (
    tester,
  ) async {
    // Still loading: the builder shows the placeholder it was given.
    await pumpCard(
      tester,
      postCard(),
      photos: (url, placeholder) => placeholder,
    );
    expect(
      find.byWidgetPredicate((w) => w is Image && w.image is MemoryImage),
      findsOneWidget,
    );
    // Loaded: the card-size variant, never the full one.
    await pumpCard(tester, postCard());
    expect(
      find.byKey(const ValueKey('photo:https://cdn.test/p1-card.webp')),
      findsOneWidget,
    );
  });

  testWidgets('no photo: an icon placeholder', (tester) async {
    await pumpCard(tester, postCard(withCover: false));
    expect(find.byIcon(Icons.image_outlined), findsOneWidget);
  });

  testWidgets('the heart: saved or not, and tappable', (tester) async {
    var taps = 0;
    await pumpCard(tester, postCard(), onToggleSaved: () => taps++);
    expect(find.byIcon(Icons.favorite_border), findsOneWidget);
    expect(find.byTooltip('সেভ করুন'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('feed-card-heart')));
    expect(taps, 1);

    await pumpCard(tester, postCard(isSaved: true), onToggleSaved: () {});
    expect(find.byIcon(Icons.favorite), findsOneWidget);
    expect(find.byTooltip('সেভ থেকে সরান'), findsOneWidget);
  });

  testWidgets('no heart where saving makes no sense', (tester) async {
    await pumpCard(tester, postCard());
    expect(find.byKey(const ValueKey('feed-card-heart')), findsNothing);
  });
}

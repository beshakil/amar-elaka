import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/network_photo.dart';
import 'package:amar_elaka_app/core/map/base_map.dart';
import 'package:amar_elaka_app/features/seller_dashboard/data/seller_analytics_api.dart';
import 'package:amar_elaka_app/features/seller_dashboard/presentation/seller_dashboard_screen.dart';
import 'package:amar_elaka_app/features/store/data/store_api.dart';
import 'package:amar_elaka_app/features/store/presentation/store_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../feed/feed_test_harness.dart';
import '../../feed/goldens/feed_golden_test.dart' show decodeImages;
import '../../post/goldens/golden_fonts.dart';
import '../store_test_fakes.dart';

/// The store page and the seller dashboard in Bengali, light and dark, with
/// the real font: shaping, Bengali digits, the open pill, stock badges and
/// the charts show up as pixel diffs.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/store/goldens
void main() {
  setUpAll(loadAppFonts);

  Future<void> pump(
    WidgetTester tester,
    ThemeData theme,
    Widget screen,
    Size size,
  ) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 2.5;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          storeApiProvider.overrideWithValue(FakeStoreApi(storePage())),
          sellerAnalyticsApiProvider.overrideWithValue(
            FakeSellerAnalyticsApi(),
          ),
          baseMapEnabledProvider.overrideWithValue(false),
        ],
        child: NetworkPhotoOverride(
          builder: (url, placeholder) =>
              url.contains('p1-') ? loadedPhoto(url, placeholder) : placeholder,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme,
            locale: const Locale('bn'),
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: screen,
          ),
        ),
      ),
    );
    await decodeImages(tester);
  }

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('store page, $name', (tester) async {
      await pump(
        tester,
        theme,
        const StoreScreen(slug: 'rahim-electronics'),
        const Size(1080, 3400),
      );
      expect(find.text('এখন খোলা'), findsOneWidget);
      expect(find.text('স্টকে নেই'), findsOneWidget);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('store_page_$name.png'),
      );
    });

    testWidgets('seller dashboard, $name', (tester) async {
      await pump(
        tester,
        theme,
        const SellerDashboardScreen(storeId: 's1', animate: false),
        const Size(1080, 3600),
      );
      expect(
        find.text(
          'গত ৩০ দিনে ১,২৪০ জন আপনার পোস্ট দেখেছেন, ৪৭ জন যোগাযোগ করেছেন।',
        ),
        findsOneWidget,
      );
      expect(find.text(ConjunctText.brand), findsOneWidget);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('seller_dashboard_$name.png'),
      );
    });
  }
}

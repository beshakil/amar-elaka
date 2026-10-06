import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/network_photo.dart';
import 'package:amar_elaka_app/features/map/presentation/map_preview_sheet.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../feed/feed_test_harness.dart' show loadedPhoto;
import '../../post/goldens/golden_fonts.dart';

/// The Map tab's preview sheet (ADR 046) in Bengali, light and dark: a
/// conjunct-heavy name drawn by Flutter (never map text), open now, the
/// straight-line distance, the address, the three actions and a road answer
/// with Barikoi's credit. A shaping or layout change shows up as a pixel diff.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/map/goldens
void main() {
  setUpAll(loadAppFonts);

  const feature = MapFeature(
    id: 'place-1',
    geometry: MapPointGeometry(coordinates: [90.369, 23.807]),
    properties: MapFeatureProperties(
      cluster: false,
      layer: 'places',
      kind: 'hospital',
      id: 'place-1',
      tenantId: 't1',
      nameBn: ConjunctText.brand,
      nameEn: 'Stratus Hospital',
      openNow: true,
    ),
  );
  const preview = MapPreview(
    layer: 'places',
    id: 'place-1',
    tenantId: 't1',
    name: MapName(bn: ConjunctText.brand, en: 'Stratus Hospital'),
    photo: MapPreviewPhoto(
      url: 'https://media.test/p1-card.webp',
      thumbhash: null,
    ),
    phones: ['+8801799300555'],
    address: ConjunctText.place,
  );
  const hospital = MapKind(
    code: 'hospital',
    icon: 'hospital',
    label: MapKindLabel(bn: 'হাসপাতাল', en: 'Hospitals'),
  );

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('map preview sheet, $name', (tester) async {
      tester.view.physicalSize = const Size(1080, 1500);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        NetworkPhotoOverride(
          builder: loadedPhoto,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme,
            locale: const Locale('bn'),
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: Material(
                  elevation: 2,
                  child: MapPreviewSheet(
                    feature: feature,
                    kind: hospital,
                    preview: preview,
                    loading: false,
                    failed: false,
                    straightMeters: 871.4,
                    road: const RoadAnswered(
                      RouteAnswer(
                        mode: 'car',
                        distanceMeters: 1971,
                        durationSeconds: 1782,
                        polyline: null,
                        source: 'barikoi',
                        degraded: false,
                      ),
                    ),
                    onRoad: () {},
                    onDirections: () {},
                    onCall: () {},
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MapPreviewSheet),
        matchesGoldenFile('map_preview_$name.png'),
      );
    });
  }
}

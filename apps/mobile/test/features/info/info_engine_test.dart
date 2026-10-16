import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/info/application/info_engine_providers.dart';
import 'package:amar_elaka_app/features/info/application/info_providers.dart';
import 'package:amar_elaka_app/features/info/presentation/info_card_tile.dart';
import 'package:amar_elaka_app/features/info/presentation/info_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

/// The info engine on the phone (ADR 065): one card for every type (and on
/// the feed), the hub listing every service (farming only where offered),
/// and the notification deep links.

Map<String, dynamic> _card({bool stale = false}) => {
  'type': 'transport',
  'id': 'r1',
  'tenantId': 't1',
  'title': {'bn': 'ঢাকা–টাঙ্গাইল বাস', 'en': null},
  'summary': null,
  'badges': ['bus'],
  'startsAt': null,
  'endsAt': null,
  'updatedAt': '2026-10-01T00:00:00Z',
  'isStale': stale,
  'distanceMeters': 820,
  'location': null,
  'image': null,
};

Widget _app(Widget home, {List<Override> overrides = const []}) =>
    ProviderScope(
      overrides: overrides,
      child: MaterialApp(
        locale: const Locale('bn'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Scaffold(body: home),
      ),
    );

void main() {
  group('feed items', () {
    test('parses the info and prayer cards', () {
      final info = FeedItem.fromJson({'kind': 'info', 'card': _card()});
      expect(info, isA<FeedInfoCard>());
      expect((info! as FeedInfoCard).card.has('bus'), isTrue);
      expect(FeedItem.fromJson({'kind': 'prayer'}), isA<FeedPrayerCard>());
    });
  });

  group('InfoCardTile', () {
    testWidgets('names the type on the feed and flags stale data', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(
          InfoCardTile(
            card: InfoCard.fromJson(_card(stale: true)),
            showType: true,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('যাতায়াত'), findsOneWidget);
      expect(find.text('ঢাকা–টাঙ্গাইল বাস'), findsOneWidget);
      expect(find.text('তথ্য পুরোনো হতে পারে'), findsOneWidget);
    });

    testWidgets('fresh data carries no stale badge', (tester) async {
      await tester.pumpWidget(
        _app(InfoCardTile(card: InfoCard.fromJson(_card()))),
      );
      await tester.pumpAndSettle();
      expect(find.text('তথ্য পুরোনো হতে পারে'), findsNothing);
    });
  });

  group('InfoScreen', () {
    Future<void> pumpHub(WidgetTester tester, {required bool agri}) async {
      await tester.pumpWidget(
        _app(
          const InfoScreen(),
          overrides: [
            isAreaTeamProvider.overrideWithValue(false),
            agriEnabledProvider.overrideWith((ref) async => agri),
          ],
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('lists every service, without farming by default', (
      tester,
    ) async {
      await pumpHub(tester, agri: false);
      expect(find.text('নামাজের সময়'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('হারানো ও প্রাপ্তি'), 200);
      expect(find.text('হারানো ও প্রাপ্তি'), findsOneWidget);
      expect(find.text('কৃষি তথ্য', skipOffstage: false), findsNothing);
    });

    testWidgets('shows farming where the area offers it', (tester) async {
      await pumpHub(tester, agri: true);
      await tester.scrollUntilVisible(find.text('কৃষি তথ্য'), 200);
      expect(find.text('কৃষি তথ্য'), findsOneWidget);
    });
  });

  group('deep links', () {
    test('decision and contact notices open the item', () {
      expect(
        appRouteForDeepLink('/info/notices/n1'),
        RoutePaths.noticeFor('n1'),
      );
      expect(
        appRouteForDeepLink('/info/lost-found/l1'),
        RoutePaths.lostFoundFor('l1'),
      );
    });
  });
}

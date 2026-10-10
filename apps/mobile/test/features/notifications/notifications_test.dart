import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/notifications/application/inbox_controller.dart';
import 'package:amar_elaka_app/features/notifications/data/notifications_api.dart';
import 'package:amar_elaka_app/features/notifications/presentation/notification_text.dart';
import 'package:amar_elaka_app/features/notifications/presentation/notifications_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// The in-app inbox: every type worded from its params, unread marked,
/// opening one marks it read and follows a link the app has.

InboxItem _item(
  String id,
  String type, {
  Map<String, String?> params = const {},
  String? deepLink,
  bool read = false,
}) => InboxItem(
  id: id,
  type: type,
  params: params,
  deepLink: deepLink,
  read: read,
  createdAt: DateTime.utc(2026, 10, 7),
);

class FakeNotificationsApi implements NotificationsApi {
  FakeNotificationsApi(this.pages);

  /// Page per cursor (null = the first).
  final Map<String?, InboxPage> pages;
  final read = <String>[];
  var readAll = 0;

  @override
  Future<InboxPage> page({String? cursor}) async => pages[cursor]!;

  @override
  Future<int> unreadCount() async => 2;

  @override
  Future<void> markRead(String id) async => read.add(id);

  @override
  Future<void> markAllRead() async => readAll++;
}

final _l10n = lookupAppLocalizations(const Locale('bn'));

Future<GoRouter> _pumpInbox(
  WidgetTester tester,
  FakeNotificationsApi api,
) async {
  final router = GoRouter(
    initialLocation: '/notifications',
    routes: [
      GoRoute(
        path: '/notifications',
        builder: (_, _) => const NotificationsScreen(),
      ),
      GoRoute(
        path: '/posts/:id',
        builder: (_, state) => Text('post ${state.pathParameters['id']}'),
      ),
      GoRoute(
        path: '/places/:id',
        builder: (_, state) => Text('place ${state.pathParameters['id']}'),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [notificationsApiProvider.overrideWithValue(api)],
      child: MaterialApp.router(
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return router;
}

void main() {
  group('notificationText', () {
    String title(InboxItem item) => notificationText(item, _l10n, 'bn').title;
    String? body(InboxItem item) => notificationText(item, _l10n, 'bn').body;

    test('places: the name, and the reason when refused', () {
      final edit = _item(
        '1',
        'place_edit_rejected',
        params: {
          'placeName': 'করিম ফার্মেসি',
          'reasonCode': 'suggestion_incorrect',
        },
      );
      expect(title(edit), _l10n.notePlaceEditRejected);
      expect(
        body(edit),
        'করিম ফার্মেসি — ${_l10n.noteReasonSuggestionIncorrect}',
      );
      final claim = _item(
        '2',
        'place_claim_rejected',
        params: {
          'placeName': 'রহিম স্টোর',
          'reasonCode': 'place_already_claimed',
        },
      );
      expect(body(claim), 'রহিম স্টোর — ${_l10n.noteReasonAlreadyClaimed}');
      // A moderator's own words win over the code.
      final words = _item(
        '3',
        'place_rejected',
        params: {
          'placeName': 'X',
          'reasonCode': 'spam',
          'reasonText': 'ভুয়া দোকান',
        },
      );
      expect(body(words), 'X — ভুয়া দোকান');
      expect(
        title(_item('4', 'place_edit_approved', params: {'placeName': 'X'})),
        _l10n.notePlaceEditApproved,
      );
    });

    test('posts and saved searches, in Bengali digits', () {
      final match = _item(
        '5',
        'saved_search_match',
        params: {'name': 'ফ্ল্যাট', 'count': '3'},
      );
      expect(title(match), _l10n.noteSavedSearchMatch('৩'));
      expect(body(match), 'ফ্ল্যাট');
      expect(
        title(_item('6', 'post_approved', params: {'postTitle': 'আইফোন'})),
        _l10n.notePostApproved,
      );
    });

    test('a type the app does not know yet still shows', () {
      expect(title(_item('7', 'something_new')), _l10n.noteGeneric);
    });

    test('only links the app has a screen for are followed', () {
      expect(
        appRouteForDeepLink('/posts/abc'),
        RoutePaths.postDetailFor('abc'),
      );
      expect(appRouteForDeepLink('/saved-searches/abc'), isNotNull);
      expect(appRouteForDeepLink('/places/abc'), isNotNull);
      expect(appRouteForDeepLink('/chat/c1'), RoutePaths.conversationFor('c1'));
      expect(appRouteForDeepLink('/somewhere-else'), isNull);
      expect(appRouteForDeepLink(null), isNull);
    });
  });

  testWidgets('opening one marks it read and follows its link', (tester) async {
    final api = FakeNotificationsApi({
      null: InboxPage(
        items: [
          _item(
            'n1',
            'post_approved',
            params: {'postTitle': 'আইফোন'},
            deepLink: '/posts/p1',
          ),
          _item(
            'n2',
            'place_edit_approved',
            params: {'placeName': 'করিম'},
            read: true,
          ),
        ],
        nextCursor: null,
        unreadCount: 1,
      ),
    });
    await _pumpInbox(tester, api);
    expect(find.text(_l10n.notePostApproved), findsOneWidget);
    expect(find.text('করিম'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('notification-n1')));
    await tester.pumpAndSettle();
    expect(api.read, ['n1']);
    expect(find.text('post p1'), findsOneWidget);
  });

  testWidgets(
    'read-all clears every unread; a place notification opens the place',
    (tester) async {
      final api = FakeNotificationsApi({
        null: InboxPage(
          items: [
            _item(
              'n1',
              'place_claim_approved',
              params: {'placeName': 'রহিম'},
              deepLink: '/places/x',
            ),
            _item(
              'n2',
              'saved_search_paused',
              params: {'name': 'গাড়ি', 'idleDays': '30'},
            ),
          ],
          nextCursor: null,
          unreadCount: 2,
        ),
      });
      await _pumpInbox(tester, api);
      expect(
        find.text('গাড়ি — ${_l10n.noteSavedSearchIdle('৩০')}'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('notifications-read-all')));
      await tester.pumpAndSettle();
      expect(api.readAll, 1);
      expect(
        find.byKey(const ValueKey('notifications-read-all')),
        findsNothing,
      );

      await tester.tap(find.byKey(const ValueKey('notification-n1')));
      await tester.pumpAndSettle();
      // The place screen (/places/:id) opens.
      expect(find.text('place x'), findsOneWidget);
    },
  );

  testWidgets('pages on as the list ends; an empty inbox says so', (
    tester,
  ) async {
    final api = FakeNotificationsApi({
      null: InboxPage(
        items: [_item('n1', 'post_approved')],
        nextCursor: 'n1',
        unreadCount: 2,
      ),
      'n1': InboxPage(
        items: [_item('n0', 'post_removed')],
        nextCursor: null,
        unreadCount: 2,
      ),
    });
    await _pumpInbox(tester, api);
    expect(find.byKey(const ValueKey('notification-n0')), findsOneWidget);

    final empty = FakeNotificationsApi({
      null: const InboxPage(items: [], nextCursor: null, unreadCount: 0),
    });
    await _pumpInbox(tester, empty);
    expect(find.byKey(const ValueKey('notifications-empty')), findsOneWidget);
  });

  testWidgets('the bell shows the unread count in Bengali digits', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          unreadNotificationsProvider.overrideWith((ref) async => 12),
        ],
        child: MaterialApp(
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const Scaffold(body: NotificationsBell()),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('১২'), findsOneWidget);
  });
}

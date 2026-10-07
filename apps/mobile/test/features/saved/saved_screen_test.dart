import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/saved/data/saved_api.dart';
import 'package:amar_elaka_app/features/saved/presentation/saved_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// "সেভ করা" (ADR 037): the user's saved items with their state, filters,
/// a post opening its detail, and removing one.

SavedItem _item(
  String id,
  String type, {
  String state = 'available',
  String? name = 'আইফোন ১৩',
  String? price,
}) => SavedItem(
  itemType: type,
  itemId: id,
  state: state,
  nameBn: name,
  nameEn: null,
  price: price,
  coverUrl: null,
  coverThumbhash: null,
  areaBn: 'মিরপুর-১০',
  areaEn: 'Mirpur-10',
);

class FakeSavedApi implements SavedApi {
  FakeSavedApi(this.pages);

  /// Page per (type, cursor).
  final Map<(String?, String?), SavedPage> pages;
  final queries = <(String?, String?)>[];
  final unsaved = <String>[];
  AppException? unsaveError;

  @override
  Future<SavedPage> list({String? type, String? cursor}) async {
    queries.add((type, cursor));
    return pages[(type, cursor)] ??
        const SavedPage(items: [], nextCursor: null);
  }

  @override
  Future<void> unsave(String itemType, String itemId) async {
    if (unsaveError case final e?) throw e;
    unsaved.add('$itemType/$itemId');
  }
}

final _l10n = lookupAppLocalizations(const Locale('bn'));

Future<void> _pump(WidgetTester tester, FakeSavedApi api) async {
  final router = GoRouter(
    initialLocation: '/saved',
    routes: [
      GoRoute(path: '/saved', builder: (_, _) => const SavedScreen()),
      GoRoute(
        path: '/posts/:id',
        builder: (_, state) => Text('post ${state.pathParameters['id']}'),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [savedApiProvider.overrideWithValue(api)],
      child: MaterialApp.router(
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'lists what was saved, marking what sold or closed; a post opens',
    (tester) async {
      final api = FakeSavedApi({
        (null, null): SavedPage(
          items: [
            _item('p1', 'post', price: '65000.00'),
            _item('p2', 'post', state: 'sold', name: 'সাইকেল'),
            _item('pl1', 'place', state: 'closed', name: 'রহিম স্টোর'),
            _item('p3', 'post', state: 'removed', name: null),
          ],
          nextCursor: null,
        ),
      });
      await _pump(tester, api);
      expect(find.text('আইফোন ১৩'), findsOneWidget);
      expect(find.text('৳ ৬৫,০০০ · মিরপুর-১০'), findsOneWidget);
      expect(find.text('মিরপুর-১০ · ${_l10n.savedStateSold}'), findsOneWidget);
      expect(
        find.text('মিরপুর-১০ · ${_l10n.savedStateClosed}'),
        findsOneWidget,
      );
      // A post a moderator removed shows nothing of itself.
      expect(find.text(_l10n.savedRemovedItem), findsOneWidget);

      await tester.tap(find.text('আইফোন ১৩'));
      await tester.pumpAndSettle();
      expect(find.text('post p1'), findsOneWidget);
    },
  );

  testWidgets('filters by kind', (tester) async {
    final api = FakeSavedApi({
      (null, null): SavedPage(items: [_item('p1', 'post')], nextCursor: null),
      ('place', null): SavedPage(
        items: [_item('pl1', 'place', name: 'রহিম স্টোর')],
        nextCursor: null,
      ),
    });
    await _pump(tester, api);
    await tester.tap(find.byKey(const ValueKey('saved-filter-place')));
    await tester.pumpAndSettle();
    expect(api.queries.last, ('place', null));
    expect(find.text('রহিম স্টোর'), findsOneWidget);
    expect(find.text('আইফোন ১৩'), findsNothing);
  });

  testWidgets('removing one takes it off at once; a failure puts it back', (
    tester,
  ) async {
    final api = FakeSavedApi({
      (null, null): SavedPage(
        items: [
          _item('p1', 'post'),
          _item('p2', 'post', name: 'সাইকেল'),
        ],
        nextCursor: null,
      ),
    });
    await _pump(tester, api);
    await tester.tap(find.byKey(const ValueKey('saved-unsave-p1')));
    await tester.pumpAndSettle();
    expect(api.unsaved, ['post/p1']);
    expect(find.text('আইফোন ১৩'), findsNothing);
    expect(find.text(_l10n.savedRemoved), findsOneWidget);

    api.unsaveError = const NetworkException();
    await tester.tap(find.byKey(const ValueKey('saved-unsave-p2')));
    await tester.pumpAndSettle();
    expect(find.text('সাইকেল'), findsOneWidget);
    expect(find.text(_l10n.savedRemoveFailed), findsOneWidget);
  });

  testWidgets('pages on as the list ends; an empty list says so', (
    tester,
  ) async {
    final api = FakeSavedApi({
      (null, null): SavedPage(items: [_item('p1', 'post')], nextCursor: 'p1'),
      (null, 'p1'): SavedPage(
        items: [_item('p0', 'post', name: 'পুরনো')],
        nextCursor: null,
      ),
    });
    await _pump(tester, api);
    expect(find.text('পুরনো'), findsOneWidget);
    expect(api.queries, [(null, null), (null, 'p1')]);

    await _pump(tester, FakeSavedApi({}));
    expect(find.byKey(const ValueKey('saved-empty')), findsOneWidget);
  });
}

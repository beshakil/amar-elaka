import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'feed_test_harness.dart';

/// A buyer's path, start to finish: open the feed → filter a category →
/// open a post → save it → call the seller. Runs headless in CI
/// (test/features/feed/feed_happy_path_test.dart) and on a device
/// (integration_test/feed_happy_path_test.dart). The API is faked; the call
/// is caught at the dialer.
Future<void> runFeedHappyPath(WidgetTester tester) async {
  final feed = FakeFeedApi()
    ..firstPage = feedPageJson([
      postCardJson(postCard()),
      emergencyJson,
      postCardJson(postCard(id: 'p2', title: 'স্যামসাং গ্যালাক্সি')),
    ]);
  final app = await pumpFeedApp(tester, feed: feed);

  // The feed.
  expect(find.text('আইফোন ১৩, ১২৮ জিবি'), findsOneWidget);

  // A category, then its filter sheet: used phones only.
  await tester.tap(find.byKey(const ValueKey('feed-category-mobile-phones')));
  await settleFeed(tester);
  await tester.tap(find.byKey(const ValueKey('feed-filter-button')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('ব্যবহৃত'));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('feed-filter-apply')));
  await settleFeed(tester);
  final asked = app.feed.requests.last.query;
  expect(asked.categorySlug, 'mobile-phones');
  expect(asked.filtersJson, '{"condition":{"eq":"used"}}');

  // The post.
  await tester.tap(find.text('আইফোন ১৩, ১২৮ জিবি'));
  await settleFeed(tester);
  expect(find.byKey(const ValueKey('detail-body')), findsOneWidget);
  expect(app.engagement.views, ['p1']);

  // Save it.
  await tester.tap(find.byKey(const ValueKey('detail-save')));
  await tester.pumpAndSettle();
  expect(app.engagement.saved, ['p1']);

  // Call: the lead is recorded, then the dialer opens with the number.
  await tester.tap(find.byKey(const ValueKey('detail-call')));
  await tester.pumpAndSettle();
  expect(app.engagement.contacts, [('p1', 'call')]);
  expect(app.apps.opened.single.toString(), 'tel:+8801711111111');

  // Back on the feed, the post's heart is filled.
  app.router.pop();
  await settleFeed(tester);
  expect(find.byIcon(Icons.favorite), findsOneWidget);
}

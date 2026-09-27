import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/feed/domain/feed_query.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../post/post_test_harness.dart';
import 'feed_test_harness.dart';

void main() {
  testWidgets('shows the first page, with info cards between posts', (
    tester,
  ) async {
    final feed = FakeFeedApi()
      ..firstPage = feedPageJson([
        postCardJson(postCard()),
        emergencyJson,
        postCardJson(postCard(id: 'p2', title: 'স্যামসাং গ্যালাক্সি')),
        bazarJson,
      ]);
    await pumpFeedApp(tester, feed: feed);

    expect(find.text('আইফোন ১৩, ১২৮ জিবি'), findsOneWidget);
    expect(find.text('স্যামসাং গ্যালাক্সি'), findsOneWidget);
    expect(find.text('জরুরি নম্বর'), findsOneWidget);
    expect(find.textContaining('৯৯৯'), findsOneWidget);
    expect(find.text('আজকের বাজারদর'), findsOneWidget);
    expect(find.text('৳ ৫২–৫৬/কেজি'), findsOneWidget);
    expect(feed.requests.single.query.scope, FeedScope.area);
  });

  testWidgets('scope switcher and category chips ask for that feed', (
    tester,
  ) async {
    final app = await pumpFeedApp(tester);

    await tester.tap(find.text('আশেপাশে'));
    await settleFeed(tester);
    expect(app.feed.requests.last.query.scope, FeedScope.nearby);

    await tester.tap(find.byKey(const ValueKey('feed-category-mobile-phones')));
    await settleFeed(tester);
    expect(app.feed.requests.last.query.categorySlug, 'mobile-phones');
    expect(app.feed.requests.last.query.scope, FeedScope.nearby);
  });

  testWidgets(
    "the filter sheet is the category's schema, sent as the API's JSON",
    (tester) async {
      final app = await pumpFeedApp(tester);
      expect(find.byKey(const ValueKey('feed-filter-button')), findsNothing);
      await tester.tap(
        find.byKey(const ValueKey('feed-category-mobile-phones')),
      );
      await settleFeed(tester);

      await tester.tap(find.byKey(const ValueKey('feed-filter-button')));
      await tester.pumpAndSettle();
      expect(find.text('মোবাইল ফোন — ফিল্টার'), findsOneWidget);
      await tester.tap(find.text('ব্যবহৃত'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('feed-filter-apply')));
      await settleFeed(tester);

      final query = app.feed.requests.last.query;
      expect(query.filtersJson, '{"condition":{"eq":"used"}}');
      expect(find.text('ফিল্টার (১)'), findsOneWidget);

      // Reopened, it shows what was chosen.
      await tester.tap(find.byKey(const ValueKey('feed-filter-button')));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilterChip>(find.widgetWithText(FilterChip, 'ব্যবহৃত'))
            .selected,
        isTrue,
      );
    },
  );

  testWidgets('scrolling to the end asks for the next page by cursor', (
    tester,
  ) async {
    final feed = FakeFeedApi()
      ..firstPage = feedPageJson([
        for (var i = 0; i < 10; i++)
          postCardJson(postCard(id: 'a$i', title: 'প্রথম পাতা $i')),
      ], nextCursor: 'c2')
      ..pagesAfter['c2'] = feedPageJson([
        for (var i = 0; i < 3; i++)
          postCardJson(postCard(id: 'b$i', title: 'দ্বিতীয় পাতা $i')),
      ]);
    await pumpFeedApp(tester, feed: feed);

    await tester.scrollUntilVisible(
      find.text('দ্বিতীয় পাতা 2'),
      400,
      scrollable: find.byWidgetPredicate(
        (w) => w is Scrollable && w.axisDirection == AxisDirection.down,
      ),
    );
    await settleFeed(tester);
    expect(feed.requests.map((r) => r.cursor), [null, 'c2']);
    expect(find.text('দ্বিতীয় পাতা 2'), findsOneWidget);
  });

  testWidgets('pull to refresh asks for the first page again', (tester) async {
    final app = await pumpFeedApp(tester);
    await tester.fling(
      find.text('আইফোন ১৩, ১২৮ জিবি'),
      const Offset(0, 500),
      1000,
    );
    await settleFeed(tester);
    expect(app.feed.requests.where((r) => r.cursor == null), hasLength(2));
  });

  testWidgets('offline: the last feed it saw, with a banner — never blank', (
    tester,
  ) async {
    final db = memoryDatabase();
    addTearDown(() => tester.runAsync(db.close));
    // A first visit caches the first page...
    final online = FakeFeedApi()
      ..firstPage = feedPageJson([
        postCardJson(postCard(title: 'গতকালের পোস্ট')),
      ]);
    await pumpFeedApp(tester, feed: online, db: db);
    await tester.pumpWidget(const SizedBox());

    // ...and the next opening, offline, shows it.
    final offline = FakeFeedApi()..failWith = const NetworkException();
    await pumpFeedApp(tester, feed: offline, db: db);
    expect(find.text('গতকালের পোস্ট'), findsOneWidget);
    expect(find.byKey(const ValueKey('feed-offline-banner')), findsOneWidget);
    expect(find.textContaining('অফলাইন'), findsOneWidget);
  });

  testWidgets('offline with nothing cached: says so, with a retry', (
    tester,
  ) async {
    final feed = FakeFeedApi()..failWith = const NetworkException();
    await pumpFeedApp(tester, feed: feed);
    expect(find.text('ফিড আনা যায়নি'), findsOneWidget);
    expect(find.textContaining('ইন্টারনেট সংযোগ নেই'), findsOneWidget);

    feed.failWith = null;
    await tester.tap(find.text('আবার চেষ্টা করুন'));
    await settleFeed(tester);
    expect(find.text('আইফোন ১৩, ১২৮ জিবি'), findsOneWidget);
  });

  testWidgets('the heart saves at once, and unsaves', (tester) async {
    final app = await pumpFeedApp(tester);
    await tester.tap(find.byKey(const ValueKey('feed-card-heart')));
    await tester.pumpAndSettle();
    expect(app.engagement.saved, ['p1']);
    expect(find.byIcon(Icons.favorite), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('feed-card-heart')));
    await tester.pumpAndSettle();
    expect(app.engagement.unsaved, ['p1']);
    expect(find.byIcon(Icons.favorite_border), findsOneWidget);
  });

  testWidgets('a refused save flips the heart back and says so', (
    tester,
  ) async {
    final engagement = FakeEngagementApi()
      ..saveError = const NetworkException();
    await pumpFeedApp(tester, engagement: engagement);
    await tester.tap(find.byKey(const ValueKey('feed-card-heart')));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.favorite_border), findsOneWidget);
    expect(find.text('সেভ করা যায়নি — আবার চেষ্টা করুন'), findsOneWidget);
  });

  testWidgets('a guest tapping the heart is asked to sign in', (tester) async {
    final app = await pumpFeedApp(tester, signedIn: false);
    await tester.tap(find.byKey(const ValueKey('feed-card-heart')));
    await tester.pumpAndSettle();
    expect(find.text('login-screen'), findsOneWidget);
    expect(app.engagement.saved, isEmpty);
  });

  testWidgets('a card opens its detail', (tester) async {
    await pumpFeedApp(tester);
    await tester.tap(find.text('আইফোন ১৩, ১২৮ জিবি'));
    await settleFeed(tester);
    expect(find.byKey(const ValueKey('detail-body')), findsOneWidget);
  });
}

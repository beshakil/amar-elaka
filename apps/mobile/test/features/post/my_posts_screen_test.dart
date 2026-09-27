import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  FakePostsApi withPosts() => FakePostsApi()
    ..posts = [
      fakePost(id: 'live1', status: 'live'),
      fakePost(id: 'live2', status: 'live', title: 'স্যামসাং এ৫৪'),
      fakePost(id: 'pend1', status: 'pending', title: 'রিভিউয়ের পোস্ট'),
      fakePost(
        id: 'sold1',
        status: 'sold',
        title: 'বিক্রি হওয়া ফোন',
        soldPrice: '60000.00',
      ),
      fakePost(
        id: 'rej1',
        status: 'rejected',
        title: 'বাতিল পোস্ট',
        moderationReason: 'wrong_category',
        moderationNote: 'এটা গাড়ির ক্যাটাগরিতে দিন',
      ),
      fakePost(id: 'hid1', status: 'live', title: 'লুকানো পোস্ট', hidden: true),
    ];

  Future<void> openTab(WidgetTester tester, String name) async {
    // The tab bar scrolls: later tabs start off-screen on a phone.
    await tester.ensureVisible(find.byKey(ValueKey('tab-$name')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('tab-$name')));
    await tester.pumpAndSettle();
  }

  testWidgets('a tab per status, each with its count in Bengali digits', (
    tester,
  ) async {
    await pumpPostApp(
      tester,
      api: withPosts(),
      initialLocation: RoutePaths.myPosts,
    );
    expect(find.text('লাইভ ২'), findsOneWidget);
    expect(find.text('রিভিউতে ১'), findsOneWidget);
    expect(find.text('বিক্রি হয়েছে ১'), findsOneWidget);
    expect(find.text('মেয়াদ শেষ ০'), findsOneWidget);
    expect(find.text('বাতিল/সরানো ১'), findsOneWidget);
    expect(find.text('লুকানো ১'), findsOneWidget);
    expect(find.text('আইফোন ১৩ বিক্রি'), findsOneWidget);
    expect(
      find.text('লুকানো পোস্ট'),
      findsNothing,
    ); // hidden only under its own tab
  });

  testWidgets(
    'rejected: shows the reason and the moderator\'s note, and offers edit-and-resubmit',
    (tester) async {
      await pumpPostApp(
        tester,
        api: withPosts(),
        initialLocation: RoutePaths.myPosts,
      );
      await openTab(tester, 'rejected');
      expect(find.text('কারণ: ভুল বিভাগে দেওয়া হয়েছে'), findsOneWidget);
      expect(
        find.text('মডারেটরের মন্তব্য: এটা গাড়ির ক্যাটাগরিতে দিন'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('resubmit-rej1')), findsOneWidget);
      expect(find.byKey(const ValueKey('sold-rej1')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('resubmit-rej1')));
      await settleSaves(tester);
      expect(find.text('পোস্ট সম্পাদনা'), findsOneWidget);
      expect(find.text('ধাপ ২/৬: বিস্তারিত'), findsOneWidget);
      expect(
        find.text('বাতিল পোস্ট'),
        findsOneWidget,
      ); // its title, ready to fix
    },
  );

  testWidgets('mark sold with an optional price in Bengali digits', (
    tester,
  ) async {
    final api = withPosts();
    await pumpPostApp(tester, api: api, initialLocation: RoutePaths.myPosts);
    await tester.tap(find.byKey(const ValueKey('sold-live1')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byKey(const ValueKey('sold-price')),
        matching: find.byType(TextField),
      ),
      '৬০,০০০',
    );
    await tester.tap(find.byKey(const ValueKey('sold-confirm')));
    await tester.pumpAndSettle();
    expect(api.calls, contains('sold(60000.00):live1'));
    expect(
      find.text('বিক্রি হয়েছে হিসেবে চিহ্নিত করা হয়েছে'),
      findsOneWidget,
    );
    expect(find.text('লাইভ ১'), findsOneWidget); // moved tab, counts refreshed
    expect(find.text('বিক্রি হয়েছে ২'), findsOneWidget);
  });

  testWidgets(
    'hide, unhide and delete (with a confirm); sold posts can\'t be deleted',
    (tester) async {
      final api = withPosts();
      await pumpPostApp(tester, api: api, initialLocation: RoutePaths.myPosts);
      await tester.tap(find.byKey(const ValueKey('hide-live2')));
      await tester.pumpAndSettle();
      expect(api.calls, contains('hide:live2'));
      expect(find.text('লুকানো ২'), findsOneWidget);

      await openTab(tester, 'hidden');
      await tester.tap(find.byKey(const ValueKey('unhide-hid1')));
      await tester.pumpAndSettle();
      expect(api.calls, contains('unhide:hid1'));

      await openTab(tester, 'sold');
      expect(find.byKey(const ValueKey('delete-sold1')), findsNothing);
      expect(find.text('বিক্রি: ৳ ৬০,০০০'), findsOneWidget);

      await openTab(tester, 'pending');
      await tester.tap(find.byKey(const ValueKey('delete-pend1')));
      await tester.pumpAndSettle();
      expect(
        find.text('পোস্টটি মুছে ফেলবেন? এটি আর ফেরত আনা যাবে না।'),
        findsOneWidget,
      );
      await tester.tap(find.text('মুছে ফেলুন').last);
      await tester.pumpAndSettle();
      expect(api.calls, contains('delete:pend1'));
      expect(find.text('রিভিউতে ০'), findsOneWidget);
    },
  );

  testWidgets(
    'an action the server refuses is explained, not "something went wrong"',
    (tester) async {
      final api = withPosts()
        ..actionErrors['repost'] = apiError(
          'POST_RENEW_TOO_EARLY',
          details: {'renewableFrom': '2026-10-17T10:00:00Z'},
        );
      await pumpPostApp(tester, api: api, initialLocation: RoutePaths.myPosts);
      await tester.tap(find.byKey(const ValueKey('renew-live1')));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'মেয়াদ শেষ হওয়ার কাছাকাছি সময়ে বাড়ানো যায় — ১৭ অক্টোবর থেকে আবার চেষ্টা করুন।',
        ),
        findsOneWidget,
      );
    },
  );
}

import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../feed/feed_test_harness.dart';

void main() {
  Future<FeedTestApp> openDetail(
    WidgetTester tester, {
    FakeEngagementApi? engagement,
    FakeExternalApps? apps,
    bool signedIn = true,
  }) => pumpFeedApp(
    tester,
    engagement: engagement,
    apps: apps,
    signedIn: signedIn,
    initialLocation: RoutePaths.postDetailFor('p1'),
  );

  testWidgets('shows the post: gallery, price, fields table, seller, similar', (
    tester,
  ) async {
    final engagement = FakeEngagementApi()
      ..details['p1'] = postDetail(
        similar: [postCard(id: 'p9', title: 'আইফোন ১২')],
      );
    final app = await openDetail(tester, engagement: engagement);

    expect(
      find.byKey(const ValueKey('photo:https://cdn.test/m1-card.webp')),
      findsOneWidget,
    );
    expect(find.text('১/৩'), findsOneWidget);
    expect(find.text('৳ ৬৫,০০০ (আলোচনা সাপেক্ষে)'), findsOneWidget);
    expect(find.text('মিরপুর ১০ · ৮৫০ মি দূরে · মোবাইল ফোন'), findsOneWidget);
    // Label/value rows from the post's own schema version; price stays in the header.
    expect(find.text('অবস্থা'), findsOneWidget);
    expect(find.text('ব্যবহৃত'), findsOneWidget);
    expect(find.text('১২৮'), findsOneWidget);
    expect(find.text('দাম'), findsNothing);
    expect(find.text('রহিম মিয়া'), findsOneWidget);
    expect(find.text('বিশ্বস্ত বিক্রেতা'), findsOneWidget);
    expect(find.text('রহিম মোবাইল'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('আইফোন ১২'),
      300,
      scrollable: find.byWidgetPredicate(
        (w) => w is Scrollable && w.axisDirection == AxisDirection.down,
      ),
    );
    expect(find.text('একই রকম আরও পোস্ট'), findsOneWidget);
    expect(app.engagement.views, ['p1']);
  });

  testWidgets('the gallery swipes; a tap opens full-size photos with zoom', (
    tester,
  ) async {
    await openDetail(tester);
    await tester.drag(
      find.byKey(const ValueKey('detail-gallery')),
      const Offset(-600, 0),
    );
    await tester.pumpAndSettle();
    expect(find.text('২/৩'), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('photo:https://cdn.test/m2-card.webp')),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('full-screen-gallery')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('photo:https://cdn.test/m2-full.webp')),
      findsOneWidget,
    );
    expect(find.byType(InteractiveViewer), findsOneWidget);
  });

  testWidgets('Call: the contact endpoint first, then the dialer', (
    tester,
  ) async {
    final app = await openDetail(tester);
    await tester.tap(find.byKey(const ValueKey('detail-call')));
    await tester.pumpAndSettle();
    expect(app.engagement.contacts, [('p1', 'call')]);
    expect(app.apps.opened.single.toString(), 'tel:+8801711111111');
  });

  testWidgets('WhatsApp opens the app with the prefilled message', (
    tester,
  ) async {
    final app = await openDetail(tester);
    await tester.tap(find.byKey(const ValueKey('detail-whatsapp')));
    await tester.pumpAndSettle();
    expect(app.engagement.contacts, [('p1', 'whatsapp')]);
    final opened = app.apps.opened.single;
    expect(opened.scheme, 'whatsapp');
    expect(opened.queryParameters['phone'], '8801711111111');
    expect(opened.queryParameters['text'], contains('আমার এলাকা'));
  });

  testWidgets('WhatsApp not installed: browser, SMS or copy the number', (
    tester,
  ) async {
    final apps = FakeExternalApps(whatsappInstalled: false);
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    final app = await openDetail(tester, apps: apps);
    await tester.tap(find.byKey(const ValueKey('detail-whatsapp')));
    await tester.pumpAndSettle();
    expect(find.text('হোয়াটসঅ্যাপ পাওয়া যায়নি'), findsOneWidget);
    expect(find.text('এসএমএস পাঠান'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('whatsapp-missing-copy')));
    await tester.pumpAndSettle();
    expect(copied, '01711111111');
    expect(find.text('নম্বর কপি হয়েছে: 01711111111'), findsOneWidget);
    expect(app.apps.opened, isEmpty);

    await tester.tap(find.byKey(const ValueKey('detail-whatsapp')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ব্রাউজারে হোয়াটসঅ্যাপ খুলুন'));
    await tester.pumpAndSettle();
    expect(app.apps.opened.single.host, 'wa.me');
  });

  testWidgets("a channel the seller turned off can't be tapped", (
    tester,
  ) async {
    final engagement = FakeEngagementApi()
      ..details['p1'] = postDetail(channels: const ['call', 'sms']);
    await openDetail(tester, engagement: engagement);
    final whatsapp = tester.widget<ButtonStyleButton>(
      find.byKey(const ValueKey('detail-whatsapp')),
    );
    expect(whatsapp.onPressed, isNull);
  });

  testWidgets('the server says why a reveal was refused, in Bengali', (
    tester,
  ) async {
    final engagement = FakeEngagementApi()
      ..contactError = apiError(
        429,
        'CONTACT_LIMIT_REACHED',
        details: {'max': 30},
      );
    await openDetail(tester, engagement: engagement);
    await tester.tap(find.byKey(const ValueKey('detail-call')));
    await tester.pumpAndSettle();
    expect(
      find.text('আজ অনেকগুলো নম্বর দেখেছেন (৩০টি)। কাল আবার চেষ্টা করুন।'),
      findsOneWidget,
    );
  });

  testWidgets('where the area asks, a guest signs in before a reveal', (
    tester,
  ) async {
    final engagement = FakeEngagementApi()
      ..details['p1'] = postDetail(loginRequired: true);
    final app = await openDetail(
      tester,
      engagement: engagement,
      signedIn: false,
    );
    await tester.tap(find.byKey(const ValueKey('detail-call')));
    await tester.pumpAndSettle();
    expect(find.text('login-screen'), findsOneWidget);
    expect(app.engagement.contacts, isEmpty);
  });

  testWidgets('Save, and Share with the post\'s link', (tester) async {
    final app = await openDetail(tester);
    await tester.tap(find.byKey(const ValueKey('detail-save')));
    await tester.pumpAndSettle();
    expect(app.engagement.saved, ['p1']);
    expect(find.byTooltip('সেভ করা'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('detail-share')));
    await tester.pumpAndSettle();
    expect(
      app.apps.shared.single,
      contains('https://mirpur.amarelaka.com/s/abcd2345'),
    );
  });

  testWidgets('Report from the overflow menu', (tester) async {
    final app = await openDetail(tester);
    await tester.tap(find.byKey(const ValueKey('detail-overflow')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('রিপোর্ট করুন'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('report-scam')));
    await tester.enterText(find.byType(TextField), 'আগে টাকা চায়');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('report-send')));
    await tester.pumpAndSettle();
    expect(app.engagement.reports, [('p1', 'scam', 'আগে টাকা চায়')]);
    expect(find.text('ধন্যবাদ — এলাকার মডারেটররা দেখবেন।'), findsOneWidget);
  });

  testWidgets('the owner sees their numbers, not ways to contact themselves', (
    tester,
  ) async {
    final engagement = FakeEngagementApi()
      ..details['p1'] = postDetail(isMine: true);
    final app = await openDetail(tester, engagement: engagement);
    expect(find.byKey(const ValueKey('detail-call')), findsNothing);
    expect(find.byKey(const ValueKey('detail-overflow')), findsNothing);
    expect(
      find.text('৪২ বার দেখা · ৫ বার যোগাযোগ · ৭ জন সেভ করেছেন'),
      findsOneWidget,
    );
    expect(app.engagement.views, isEmpty);
  });

  testWidgets('a post that is gone says so; offline offers a retry', (
    tester,
  ) async {
    final engagement = FakeEngagementApi()..details.clear();
    await openDetail(tester, engagement: engagement);
    expect(find.text('পোস্টটি আর দেখা যাচ্ছে না'), findsOneWidget);
  });

  testWidgets('offline: a retry, not a blank page', (tester) async {
    final engagement = _OfflineEngagement();
    await openDetail(tester, engagement: engagement);
    expect(find.text('পোস্ট আনা যায়নি'), findsOneWidget);
    expect(find.text('আবার চেষ্টা করুন'), findsOneWidget);
  });
}

class _OfflineEngagement extends FakeEngagementApi {
  @override
  Future<Never> detail(String postId, {double? lat, double? lng}) async =>
      throw const NetworkException();
}

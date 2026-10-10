import 'package:amar_elaka_app/core/network/connectivity_provider.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/chat/data/chat_api.dart';
import 'package:amar_elaka_app/features/chat/data/chat_models.dart';
import 'package:amar_elaka_app/features/chat/data/chat_realtime.dart';
import 'package:amar_elaka_app/features/chat/presentation/conversation_screen.dart';
import 'package:amar_elaka_app/features/notifications/data/notification_settings_api.dart';
import 'package:amar_elaka_app/features/notifications/presentation/push_rationale.dart';
import 'package:amar_elaka_app/features/notifications/push/push_controller.dart';
import 'package:amar_elaka_app/features/notifications/push/push_messaging.dart';
import 'package:amar_elaka_app/features/post_detail/presentation/post_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../feed/feed_test_harness.dart';
import '../post/post_test_harness.dart' show pumpUntil;
import 'chat_test_fakes.dart';

/// A buyer opens a post → messages the seller → (asked, at that moment, if
/// they'd like notifications: yes) → the seller replies → the buyer, now
/// elsewhere in the app, gets a push → taps it → lands in that conversation
/// with the reply on screen. ADR 060. The API, the socket and FCM are fakes.
/// Run as a widget test in CI (test/features/chat/chat_happy_path_test.dart)
/// and on a device (integration_test/chat_happy_path_test.dart).
Future<void> runChatHappyPath(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final chat = FakeChatApi();
  final realtime = FakeChatRealtime();
  final push = FakePushMessaging();
  final settings = FakeNotificationSettingsApi();
  final engagement = FakeEngagementApi()..details['p1'] = postDetail();

  final app = await pumpFeedApp(
    tester,
    engagement: engagement,
    initialLocation: RoutePaths.postDetailFor('p1'),
    overrides: [
      chatApiProvider.overrideWithValue(chat),
      chatRealtimeProvider.overrideWithValue(realtime),
      pushMessagingProvider.overrideWith((ref) async => push),
      notificationSettingsApiProvider.overrideWithValue(settings),
      isOnlineProvider.overrideWith((ref) => Stream.value(true)),
    ],
    routes: [
      GoRoute(
        path: '${RoutePaths.chat}/:id',
        builder: (_, state) => ConversationScreen(conversationId: state.pathParameters['id']!),
      ),
      GoRoute(path: RoutePaths.pushRationale, builder: (_, _) => const PushRationaleScreen()),
      GoRoute(path: RoutePaths.notifications, builder: (_, _) => const Scaffold(body: Text('notification-center'))),
    ],
  );
  // What App does for the whole run: push listens from the start.
  final container = ProviderScope.containerOf(tester.element(find.byType(PostDetailScreen)));
  container.read(pushControllerProvider);
  await pumpUntil(tester, () => true);

  // The post → "মেসেজ দিন" → the conversation, with the post on top.
  await tester.tap(find.byKey(const ValueKey('detail-chat')));
  await pumpUntil(tester, () => find.byType(ConversationScreen).evaluate().isNotEmpty);
  await pumpUntil(tester, () => find.byKey(const ValueKey('chat-post-card')).evaluate().isNotEmpty);
  expect(chat.opened.single, ('p1', null));
  expect(realtime.joined, ['c1']);

  // The first message: pending, then sent.
  await tester.enterText(find.byKey(const ValueKey('chat-input')), 'আইফোনটা কি এখনো আছে?');
  await tester.pump();
  await tester.tap(find.byKey(const ValueKey('chat-send')));
  await pumpUntil(tester, () => chat.sent.isNotEmpty);
  expect((chat.sent.single.$3 as TextDraft).body, 'আইফোনটা কি এখনো আছে?');

  // That was the moment to ask about notifications: our Bengali screen first, then Android's prompt.
  await pumpUntil(tester, () => find.byKey(const ValueKey('push-rationale-accept')).evaluate().isNotEmpty);
  expect(push.prompts, 0);
  await tester.tap(find.byKey(const ValueKey('push-rationale-accept')));
  await pumpUntil(tester, () => settings.registered.isNotEmpty);
  expect(push.prompts, 1);
  expect(settings.registered.single.$2, 'fcm-token-1');
  await pumpUntil(tester, () => find.byType(ConversationScreen).evaluate().isNotEmpty);
  await pumpUntil(tester, () => find.text('আইফোনটা কি এখনো আছে?').evaluate().isNotEmpty);

  // The seller replies while the thread is open: it shows at once.
  realtime.typingFrom('c1', isTyping: true);
  await pumpUntil(tester, () => find.byKey(const ValueKey('chat-typing')).evaluate().isNotEmpty);
  realtime.deliver(chat.receive('c1', 'হ্যাঁ আছে, আজ বিকেলে দেখতে আসতে পারেন।'));
  await pumpUntil(tester, () => find.text('হ্যাঁ আছে, আজ বিকেলে দেখতে আসতে পারেন।').evaluate().isNotEmpty);

  // The buyer leaves the thread; the seller writes again; a push comes.
  app.router.go(RoutePaths.postDetailFor('p1'));
  await pumpUntil(tester, () => find.byType(ConversationScreen).evaluate().isEmpty);
  const reply = 'দাম ৬০,০০০ হলে চলবে।';
  chat.receive('c1', reply);
  push.arriveInForeground(
    const PushPayload(title: 'রহিম মিয়া', body: reply, deepLink: '/chat/c1', type: 'chat_message'),
  );
  await pumpUntil(tester, () => container.read(pushBannerProvider) != null);

  // A tap on it opens that very conversation, the new reply in it.
  push.tap(const PushPayload(title: 'রহিম মিয়া', body: reply, deepLink: '/chat/c1', type: 'chat_message'));
  await pumpUntil(tester, () => find.byType(ConversationScreen).evaluate().isNotEmpty);
  await pumpUntil(tester, () => find.text(reply).evaluate().isNotEmpty);
  expect(
    tester.widget<ConversationScreen>(find.byType(ConversationScreen)).conversationId,
    'c1',
  );
  expect(container.read(pushBannerProvider), isNull);
}

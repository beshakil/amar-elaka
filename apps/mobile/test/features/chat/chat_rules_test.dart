import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/chat/data/chat_models.dart';
import 'package:amar_elaka_app/features/notifications/data/notification_settings_api.dart';
import 'package:amar_elaka_app/features/notifications/push/push_controller.dart';
import 'package:amar_elaka_app/features/notifications/push/push_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../post/post_test_harness.dart';
import 'chat_test_fakes.dart';

void main() {
  group('ticks from the watermarks', () {
    test('sent, delivered, read — by uuid v7 order', () {
      final c = conversation(
        othersDeliveredUpTo: messageId(5),
        othersReadUpTo: messageId(3),
      );
      expect(deliveryStateOf(messageId(2), c), DeliveryState.read);
      expect(deliveryStateOf(messageId(3), c), DeliveryState.read);
      expect(deliveryStateOf(messageId(4), c), DeliveryState.delivered);
      expect(deliveryStateOf(messageId(6), c), DeliveryState.sent);
    });

    test('no watermark yet: sent', () {
      expect(deliveryStateOf(messageId(1), conversation()), DeliveryState.sent);
    });
  });

  group('where a notification or push leads', () {
    test('the exact screen for what the app has', () {
      expect(appRouteForDeepLink('/chat/c1'), RoutePaths.conversationFor('c1'));
      expect(appRouteForDeepLink('/chat'), RoutePaths.chat);
      expect(appRouteForDeepLink('/posts/p1'), RoutePaths.postDetailFor('p1'));
      expect(
        appRouteForDeepLink('/posts/p1?action=repost'),
        startsWith(RoutePaths.postDetailFor('p1')),
      );
      expect(appRouteForDeepLink('/stores/me'), RoutePaths.myStore);
    });

    test('nothing for what it does not, and a push then opens the center', () {
      expect(appRouteForDeepLink('/admin/reports'), isNull);
      expect(appRouteForDeepLink(''), isNull);
      expect(
        routeForPush(const PushPayload(deepLink: '/admin/x')),
        RoutePaths.notifications,
      );
      expect(
        routeForPush(const PushPayload(deepLink: '/chat/c9')),
        RoutePaths.conversationFor('c9'),
      );
    });
  });

  group('asking for notifications', () {
    late FakePushMessaging push;
    late ProviderContainer container;

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      push = FakePushMessaging();
      container = ProviderContainer(
        overrides: [
          pushMessagingProvider.overrideWith((ref) async => push),
          authControllerProvider.overrideWith(FakeAuthController.new),
          notificationSettingsApiProvider.overrideWithValue(
            FakeNotificationSettingsApi(),
          ),
        ],
      );
      addTearDown(container.dispose);
    });

    PushRationaleGate gate() => container.read(pushRationaleGateProvider);

    test(
      'offered at the moment, then not again soon after "not now"',
      () async {
        expect(await gate().shouldOffer(), isTrue);
        await gate().markShown();
        expect(await gate().shouldOffer(), isFalse);
      },
    );

    test('offered again after the quiet period', () async {
      final longAgo = DateTime.now().subtract(const Duration(days: 15));
      SharedPreferences.setMockInitialValues({
        'push.rationale.shownAt': longAgo.millisecondsSinceEpoch,
      });
      expect(await gate().shouldOffer(), isTrue);
    });

    test(
      'never once the system prompt was answered, or permission is settled',
      () async {
        push.answer = PushPermission.denied;
        expect(await gate().accept(), isFalse);
        expect(push.prompts, 1);
        push.current = PushPermission.notAsked;
        expect(await gate().shouldOffer(), isFalse);

        SharedPreferences.setMockInitialValues({});
        push.current = PushPermission.granted;
        expect(await gate().shouldOffer(), isFalse);
      },
    );

    test('a build without Firebase never offers', () async {
      final noPush = ProviderContainer(
        overrides: [
          pushMessagingProvider.overrideWith(
            (ref) async => const NoopPushMessaging(),
          ),
        ],
      );
      addTearDown(noPush.dispose);
      expect(
        await noPush.read(pushRationaleGateProvider).shouldOffer(),
        isFalse,
      );
    });
  });
}

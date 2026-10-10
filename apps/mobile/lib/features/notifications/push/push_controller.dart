import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/routing/app_router.dart';
import '../../../core/routing/deep_links.dart';
import '../../../core/routing/route_paths.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../../chat/application/chat_inbox_controller.dart';
import '../application/inbox_controller.dart';
import '../data/notification_settings_api.dart';
import 'push_messaging.dart';

/// The device's push support: Firebase when the build is configured, else none.
/// Tests override it with a fake.
final pushMessagingProvider = FutureProvider<PushMessaging>(
  (ref) => FirebasePushMessaging.create(),
);

/// A push that came while the app was open: the shell shows it as a banner.
class PushBanner extends Notifier<PushPayload?> {
  @override
  PushPayload? build() => null;

  void show(PushPayload payload) => state = payload;
  void dismiss() => state = null;
}

final pushBannerProvider = NotifierProvider<PushBanner, PushPayload?>(
  PushBanner.new,
);

/// Where a push leads (one rule, with the notification center): the
/// conversation, the post…; else the notification center.
String routeForPush(PushPayload payload) =>
    appRouteForDeepLink(payload.deepLink) ?? RoutePaths.notifications;

/// Push, app-wide (ADR 060). Listened by App for the whole run:
///  - signed in with permission given: the FCM token is registered
///    (PUT /me/devices/push-token) and kept fresh when FCM rotates it;
///    signing out forgets it, so the next user of the phone gets none;
///  - a tapped push (background, or the one that launched the app) opens
///    its screen through the router — the conversation itself for a chat;
///  - a push while the app is open becomes a banner (and the badges refresh).
/// It never asks for permission: that is [PushRationaleGate]'s, at a
/// meaningful moment.
class PushController {
  PushController(this._ref);

  final Ref _ref;
  final _subscriptions = <StreamSubscription<Object?>>[];
  String? _registeredToken;

  Future<void> start() async {
    final messaging = await _ref.read(pushMessagingProvider.future);
    if (!messaging.isAvailable) return;
    _subscriptions
      ..add(messaging.opened.listen(openPush))
      ..add(messaging.foreground.listen(_onForeground))
      ..add(messaging.tokenRefreshed.listen((t) => unawaited(_register(t))));
    final initial = await messaging.initialMessage();
    if (initial != null) openPush(initial);
    await syncToken();
  }

  /// Register the token when signed in with permission; forget it when signed out.
  Future<void> syncToken() async {
    final messaging = await _ref.read(pushMessagingProvider.future);
    if (!messaging.isAvailable) return;
    final signedIn =
        _ref.read(authControllerProvider) is AuthSessionAuthenticated;
    if (!signedIn) {
      final token = _registeredToken;
      _registeredToken = null;
      if (token != null) {
        await _ref
            .read(notificationSettingsApiProvider)
            .forgetPushToken(token)
            .catchError((Object _) {});
      }
      return;
    }
    if (await messaging.permission() != PushPermission.granted) return;
    final token = await messaging.token();
    if (token != null) await _register(token);
  }

  Future<void> _register(String token) async {
    if (_ref.read(authControllerProvider) is! AuthSessionAuthenticated) return;
    try {
      await _ref
          .read(notificationSettingsApiProvider)
          .registerPushToken(_platform, token);
      _registeredToken = token;
    } on Object {
      // Next start or token refresh tries again.
    }
  }

  static String get _platform =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

  /// Opens a push's screen (a tap, or the one that launched the app).
  void openPush(PushPayload payload) {
    _ref.read(pushBannerProvider.notifier).dismiss();
    unawaited(_ref.read(appRouterProvider).push(routeForPush(payload)));
  }

  void _onForeground(PushPayload payload) {
    // The thread on screen already shows its own messages.
    final route = routeForPush(payload);
    final active = _ref.read(activeConversationProvider);
    if (active != null && route == RoutePaths.conversationFor(active)) return;
    _ref.read(pushBannerProvider.notifier).show(payload);
    _ref.invalidate(unreadNotificationsProvider);
  }

  void dispose() {
    for (final s in _subscriptions) {
      unawaited(s.cancel());
    }
  }
}

final pushControllerProvider = Provider<PushController>((ref) {
  final controller = PushController(ref);
  ref.onDispose(controller.dispose);
  unawaited(controller.start());
  // Signing in or out: register or forget this device's token.
  ref.listen(
    authControllerProvider,
    (_, _) => unawaited(controller.syncToken()),
  );
  return controller;
});

/// When we ask for notifications (ADR 060): never at first launch, only at a
/// moment push obviously helps — right after the user's first post or first
/// chat message — with our own Bengali explanation first, and Android's
/// prompt only if they agree. Not again for [_quietPeriod] after "not now";
/// never once the system prompt was answered.
class PushRationaleGate {
  PushRationaleGate(this._ref);

  final Ref _ref;
  static const _shownAtKey = 'push.rationale.shownAt';
  static const _answeredKey = 'push.rationale.answered';
  static const _quietPeriod = Duration(days: 14);

  /// The moment came (first post published, first chat sent): offer it if we should.
  Future<bool> shouldOffer() async {
    final messaging = await _ref.read(pushMessagingProvider.future);
    if (!messaging.isAvailable) return false;
    if (await messaging.permission() != PushPermission.notAsked) return false;
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_answeredKey) ?? false) return false;
    final shownAt = prefs.getInt(_shownAtKey);
    if (shownAt == null) return true;
    return DateTime.now().difference(
          DateTime.fromMillisecondsSinceEpoch(shownAt),
        ) >=
        _quietPeriod;
  }

  Future<void> markShown() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_shownAtKey, DateTime.now().millisecondsSinceEpoch);
  }

  /// "চালু করুন": Android's own prompt, then the token.
  Future<bool> accept() async {
    final messaging = await _ref.read(pushMessagingProvider.future);
    final result = await messaging.requestPermission();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_answeredKey, true);
    if (result == PushPermission.granted) {
      await _ref.read(pushControllerProvider).syncToken();
    }
    return result == PushPermission.granted;
  }
}

final pushRationaleGateProvider = Provider<PushRationaleGate>(
  PushRationaleGate.new,
);

import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

/// A push as the app reads it: the server's rendered text and where it leads
/// (FCM data, apps/api/src/notifications/notification-dispatcher.ts).
class PushPayload {
  const PushPayload({this.title, this.body, this.deepLink, this.type, this.notificationId});

  factory PushPayload.fromData(Map<String, dynamic> data, {String? title, String? body}) => PushPayload(
    title: title,
    body: body,
    deepLink: _nonEmpty(data['deepLink']),
    type: _nonEmpty(data['type']),
    notificationId: _nonEmpty(data['notificationId']),
  );

  final String? title;
  final String? body;
  final String? deepLink;
  final String? type;
  final String? notificationId;

  static String? _nonEmpty(Object? v) => v is String && v.isNotEmpty ? v : null;
}

enum PushPermission { granted, denied, notAsked }

/// The device side of push (ADR 060), behind an interface so tests and a
/// build without Firebase config use [NoopPushMessaging].
abstract interface class PushMessaging {
  /// False when the build has no Firebase config: no prompt, no token.
  bool get isAvailable;

  Future<PushPermission> permission();

  /// Android 13+'s system prompt (and iOS's, when there is an iOS app).
  Future<PushPermission> requestPermission();
  Future<String?> token();
  Stream<String> get tokenRefreshed;

  /// A push while the app is open (shown as an in-app banner).
  Stream<PushPayload> get foreground;

  /// A push the user tapped while the app was in the background.
  Stream<PushPayload> get opened;

  /// The push that launched the app from killed, if any.
  Future<PushPayload?> initialMessage();
}

class NoopPushMessaging implements PushMessaging {
  const NoopPushMessaging();

  @override
  bool get isAvailable => false;
  @override
  Future<PushPermission> permission() async => PushPermission.denied;
  @override
  Future<PushPermission> requestPermission() async => PushPermission.denied;
  @override
  Future<String?> token() async => null;
  @override
  Stream<String> get tokenRefreshed => const Stream.empty();
  @override
  Stream<PushPayload> get foreground => const Stream.empty();
  @override
  Stream<PushPayload> get opened => const Stream.empty();
  @override
  Future<PushPayload?> initialMessage() async => null;
}

/// Firebase's options from the build (`--dart-define`), never a committed
/// google-services.json: a build without them has no push (ADR 060).
abstract final class FirebaseConfig {
  static const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const appId = String.fromEnvironment('FIREBASE_APP_ID');
  static const messagingSenderId = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
  static const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');

  static bool get isConfigured =>
      apiKey.isNotEmpty && appId.isNotEmpty && messagingSenderId.isNotEmpty && projectId.isNotEmpty;

  static FirebaseOptions get options => const FirebaseOptions(
    apiKey: apiKey,
    appId: appId,
    messagingSenderId: messagingSenderId,
    projectId: projectId,
  );
}

class FirebasePushMessaging implements PushMessaging {
  FirebasePushMessaging._(this._messaging);

  final FirebaseMessaging _messaging;

  /// Firebase once per process; [NoopPushMessaging] when not configured or failing.
  static Future<PushMessaging> create() async {
    if (!FirebaseConfig.isConfigured) return const NoopPushMessaging();
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp(options: FirebaseConfig.options);
      return FirebasePushMessaging._(FirebaseMessaging.instance);
    } on Object {
      return const NoopPushMessaging();
    }
  }

  @override
  bool get isAvailable => true;

  @override
  Future<PushPermission> permission() async =>
      _map((await _messaging.getNotificationSettings()).authorizationStatus);

  @override
  Future<PushPermission> requestPermission() async =>
      _map((await _messaging.requestPermission()).authorizationStatus);

  static PushPermission _map(AuthorizationStatus status) => switch (status) {
    AuthorizationStatus.authorized || AuthorizationStatus.provisional => PushPermission.granted,
    AuthorizationStatus.denied || AuthorizationStatus.deniedPermanently => PushPermission.denied,
    AuthorizationStatus.notDetermined => PushPermission.notAsked,
  };

  @override
  Future<String?> token() => _messaging.getToken();

  @override
  Stream<String> get tokenRefreshed => _messaging.onTokenRefresh;

  @override
  Stream<PushPayload> get foreground => FirebaseMessaging.onMessage.map(_payload);

  @override
  Stream<PushPayload> get opened => FirebaseMessaging.onMessageOpenedApp.map(_payload);

  @override
  Future<PushPayload?> initialMessage() async {
    final message = await _messaging.getInitialMessage();
    return message == null ? null : _payload(message);
  }

  static PushPayload _payload(RemoteMessage m) =>
      PushPayload.fromData(m.data, title: m.notification?.title, body: m.notification?.body);
}

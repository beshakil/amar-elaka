import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// One channel of one type, as the settings screen shows it.
class ChannelPreference {
  const ChannelPreference({required this.channel, required this.enabled, required this.locked});

  factory ChannelPreference.fromJson(Map<String, dynamic> json) => ChannelPreference(
    channel: json['channel'] as String,
    enabled: json['enabled'] as bool,
    locked: json['locked'] as bool,
  );

  /// in_app | push | email | sms.
  final String channel;
  final bool enabled;

  /// The user can't change it (the inbox, or a type that must reach them).
  final bool locked;

  ChannelPreference withEnabled(bool value) =>
      ChannelPreference(channel: channel, enabled: value, locked: locked);
}

class TypePreference {
  const TypePreference({required this.type, required this.urgent, required this.channels});

  factory TypePreference.fromJson(Map<String, dynamic> json) => TypePreference(
    type: json['type'] as String,
    urgent: json['urgent'] as bool,
    channels: [
      for (final c in json['channels'] as List) ChannelPreference.fromJson(c as Map<String, dynamic>),
    ],
  );

  final String type;

  /// Security and account notices: they come in quiet hours too.
  final bool urgent;
  final List<ChannelPreference> channels;
}

/// Notification settings and this device's push token (ADR 059/060):
/// GET/PUT /me/notification-preferences, PUT/DELETE /me/devices/push-token.
abstract interface class NotificationSettingsApi {
  Future<List<TypePreference>> preferences();
  Future<List<TypePreference>> setPreference(String type, String channel, {required bool enabled});
  Future<void> registerPushToken(String platform, String token);
  Future<void> forgetPushToken(String token);
}

class DioNotificationSettingsApi implements NotificationSettingsApi {
  DioNotificationSettingsApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  static List<TypePreference> _items(Map<String, dynamic> json) => [
    for (final t in json['items'] as List) TypePreference.fromJson(t as Map<String, dynamic>),
  ];

  @override
  Future<List<TypePreference>> preferences() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/me/notification-preferences');
    return _items(r.data!);
  });

  @override
  Future<List<TypePreference>> setPreference(String type, String channel, {required bool enabled}) =>
      _call(() async {
        final r = await _dio.put<Map<String, dynamic>>(
          '/me/notification-preferences',
          data: {
            'items': [
              {'type': type, 'channel': channel, 'enabled': enabled},
            ],
          },
        );
        return _items(r.data!);
      });

  @override
  Future<void> registerPushToken(String platform, String token) => _call(() async {
    await _dio.put<void>('/me/devices/push-token', data: {'platform': platform, 'token': token});
  });

  @override
  Future<void> forgetPushToken(String token) => _call(() async {
    await _dio.delete<void>('/me/devices/push-token', data: {'token': token});
  });
}

final notificationSettingsApiProvider = Provider<NotificationSettingsApi>(
  (ref) => DioNotificationSettingsApi(ref.watch(dioClientProvider)),
);

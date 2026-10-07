import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// One notification from `GET /notifications`. The server sends no text:
/// the app words it from [type] and [params] (notification_text.dart).
class InboxItem {
  const InboxItem({
    required this.id,
    required this.type,
    required this.params,
    required this.deepLink,
    required this.read,
    required this.createdAt,
  });

  factory InboxItem.fromJson(Map<String, dynamic> json) => InboxItem(
    id: json['id'] as String,
    type: json['type'] as String,
    params: {
      for (final MapEntry(:key, :value)
          in (json['params'] as Map<String, dynamic>).entries)
        key: value as String?,
    },
    deepLink: json['deepLink'] as String?,
    read: json['read'] as bool,
    createdAt: DateTime.parse(json['createdAt'] as String),
  );

  final String id;
  final String type;
  final Map<String, String?> params;
  final String? deepLink;
  final bool read;
  final DateTime createdAt;

  InboxItem asRead() => InboxItem(
    id: id,
    type: type,
    params: params,
    deepLink: deepLink,
    read: true,
    createdAt: createdAt,
  );
}

class InboxPage {
  const InboxPage({
    required this.items,
    required this.nextCursor,
    required this.unreadCount,
  });

  factory InboxPage.fromJson(Map<String, dynamic> json) => InboxPage(
    items: [
      for (final item in json['items'] as List)
        InboxItem.fromJson(item as Map<String, dynamic>),
    ],
    nextCursor: json['nextCursor'] as String?,
    unreadCount: json['unreadCount'] as int,
  );

  final List<InboxItem> items;
  final String? nextCursor;
  final int unreadCount;
}

/// The signed-in user's in-app inbox (same in every area).
abstract interface class NotificationsApi {
  Future<InboxPage> page({String? cursor});
  Future<int> unreadCount();
  Future<void> markRead(String id);
  Future<void> markAllRead();
}

class DioNotificationsApi implements NotificationsApi {
  DioNotificationsApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<InboxPage> page({String? cursor}) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/notifications',
      queryParameters: {'cursor': ?cursor},
    );
    return InboxPage.fromJson(response.data!);
  });

  @override
  Future<int> unreadCount() => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/notifications/unread-count',
    );
    return response.data!['unreadCount'] as int;
  });

  @override
  Future<void> markRead(String id) => _call(() async {
    await _dio.post<void>('/notifications/$id/read');
  });

  @override
  Future<void> markAllRead() => _call(() async {
    await _dio.post<void>('/notifications/read-all');
  });
}

final notificationsApiProvider = Provider<NotificationsApi>(
  (ref) => DioNotificationsApi(ref.watch(dioClientProvider)),
);

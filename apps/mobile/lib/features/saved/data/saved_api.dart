import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// One saved post, place or store (`GET /saved`, ADR 037). A saved item never
/// drops out of the list; [state] says why it may no longer be open to act on.
class SavedItem {
  const SavedItem({
    required this.itemType,
    required this.itemId,
    required this.state,
    required this.nameBn,
    required this.nameEn,
    required this.price,
    required this.coverUrl,
    required this.coverThumbhash,
    required this.areaBn,
    required this.areaEn,
  });

  factory SavedItem.fromJson(Map<String, dynamic> json) {
    final name = json['name'] as Map<String, dynamic>?;
    final cover = json['cover'] as Map<String, dynamic>?;
    final area = json['area'] as Map<String, dynamic>?;
    return SavedItem(
      itemType: json['itemType'] as String,
      itemId: json['itemId'] as String,
      state: json['state'] as String,
      nameBn: name?['bn'] as String?,
      nameEn: name?['en'] as String?,
      price: json['price'] as String?,
      coverUrl: cover?['url'] as String?,
      coverThumbhash: cover?['thumbhash'] as String?,
      areaBn: area?['bn'] as String?,
      areaEn: area?['en'] as String?,
    );
  }

  /// post | place | store
  final String itemType;
  final String itemId;

  /// available | sold | expired | unavailable | deleted | removed |
  /// temporarily_closed | closed
  final String state;

  /// Both null for a post a moderator removed: nothing of it is shown.
  final String? nameBn;
  final String? nameEn;

  /// Posts only: a money string, while available, sold or expired.
  final String? price;
  final String? coverUrl;
  final String? coverThumbhash;
  final String? areaBn;
  final String? areaEn;
}

class SavedPage {
  const SavedPage({required this.items, required this.nextCursor});

  final List<SavedItem> items;
  final String? nextCursor;
}

/// The signed-in user's saved posts, places and stores, across areas.
abstract interface class SavedApi {
  /// [type]: post | place | store; null for all.
  Future<SavedPage> list({String? type, String? cursor});

  Future<void> unsave(String itemType, String itemId);
}

class DioSavedApi implements SavedApi {
  DioSavedApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<SavedPage> list({String? type, String? cursor}) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/saved',
      queryParameters: {'type': ?type, 'cursor': ?cursor},
    );
    final data = response.data!;
    return SavedPage(
      items: [
        for (final item in data['items'] as List)
          SavedItem.fromJson(item as Map<String, dynamic>),
      ],
      nextCursor: data['nextCursor'] as String?,
    );
  });

  @override
  Future<void> unsave(String itemType, String itemId) => _call(() async {
    await _dio.delete<void>('/saved/$itemType/$itemId');
  });
}

final savedApiProvider = Provider<SavedApi>(
  (ref) => DioSavedApi(ref.watch(dioClientProvider)),
);

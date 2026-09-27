import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// The buyer's side of a post (ADR 036/037): detail, views, contact reveals,
/// reports and saves. Failures surface as [AppException]; the screens turn
/// its code into a Bengali sentence.
abstract interface class EngagementApi {
  Future<PostDetail> detail(String postId, {double? lat, double? lng});

  /// Counted once per viewer per window by the server; never awaited by UI.
  Future<void> view(String postId);

  /// The seller's number for [channel] (call | whatsapp | sms), recorded as a lead.
  Future<ContactReveal> contact(String postId, String channel);
  Future<void> report(String postId, String reasonCode, String? text);
  Future<void> save(String postId);
  Future<void> unsave(String postId);
}

class DioEngagementApi implements EngagementApi {
  DioEngagementApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<PostDetail> detail(String postId, {double? lat, double? lng}) =>
      _call(() async {
        final response = await _dio.get<Map<String, dynamic>>(
          '/posts/$postId/detail',
          queryParameters: {
            if (lat != null && lng != null) ...{'lat': lat, 'lng': lng},
          },
        );
        return PostDetail.fromJson(response.data!);
      });

  @override
  Future<void> view(String postId) =>
      _call(() => _dio.post<void>('/posts/$postId/view'));

  @override
  Future<ContactReveal> contact(String postId, String channel) =>
      _call(() async {
        final response = await _dio.post<Map<String, dynamic>>(
          '/posts/$postId/contact',
          data: {'channel': channel},
        );
        return ContactReveal.fromJson(response.data!);
      });

  @override
  Future<void> report(String postId, String reasonCode, String? text) => _call(
    () => _dio.post<void>(
      '/posts/$postId/report',
      data: {
        'reasonCode': reasonCode,
        if (text != null && text.trim().isNotEmpty) 'text': text.trim(),
      },
    ),
  );

  @override
  Future<void> save(String postId) =>
      _call(() => _dio.post<void>('/saved/post/$postId'));

  @override
  Future<void> unsave(String postId) =>
      _call(() => _dio.delete<void>('/saved/post/$postId'));
}

final engagementApiProvider = Provider<EngagementApi>(
  (ref) => DioEngagementApi(ref.watch(dioClientProvider)),
);

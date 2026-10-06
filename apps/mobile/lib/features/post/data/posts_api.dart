import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// The post-related API calls (apps/api: /posts, /categories, /geo).
/// Every failure surfaces as an [AppException]; the screens turn its code
/// into a Bengali sentence (post_error_messages.dart).
abstract interface class PostsApi {
  /// The categories enabled in the current tenant.
  Future<List<CatalogCategory>> categories();

  /// POST /posts with an Idempotency-Key: the same key and body return the
  /// same post, so a retry after a lost response never posts twice.
  Future<PostView> create(
    Map<String, Object?> body, {
    required String idempotencyKey,
  });
  Future<PostView> update(String id, Map<String, Object?> body);
  Future<PostView> submit(String id);
  Future<PostView> get(String id);
  Future<MyPostsPage> mine({
    List<String>? statuses,
    bool? hidden,
    String? cursor,
  });
  Future<MyPostCounts> counts();
  Future<PostView> markSold(String id, {String? soldPrice});
  Future<PostView> repost(String id);
  Future<PostView> setHidden(String id, {required bool hidden});
  Future<void> delete(String id);
  Future<PostOwnership> ownership(double lat, double lng);
}

class DioPostsApi implements PostsApi {
  DioPostsApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<PostView> _post(String path, [Object? body]) => _call(() async {
    final response = await _dio.post<Map<String, dynamic>>(path, data: body);
    return PostView.fromJson(response.data!);
  });

  @override
  Future<List<CatalogCategory>> categories() => _call(() async {
    final response = await _dio.get<List<dynamic>>('/categories');
    return [
      for (final item in response.data!)
        CatalogCategory.fromJson(item as Map<String, dynamic>),
    ];
  });

  @override
  Future<PostView> create(
    Map<String, Object?> body, {
    required String idempotencyKey,
  }) => _call(() async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/posts',
      data: body,
      options: Options(headers: {'Idempotency-Key': idempotencyKey}),
    );
    return PostView.fromJson(response.data!);
  });

  @override
  Future<PostView> update(String id, Map<String, Object?> body) =>
      _call(() async {
        final response = await _dio.patch<Map<String, dynamic>>(
          '/posts/$id',
          data: body,
        );
        return PostView.fromJson(response.data!);
      });

  @override
  Future<PostView> submit(String id) => _post('/posts/$id/submit');

  @override
  Future<PostView> get(String id) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/posts/$id');
    return PostView.fromJson(response.data!);
  });

  @override
  Future<MyPostsPage> mine({
    List<String>? statuses,
    bool? hidden,
    String? cursor,
  }) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/posts/me',
      queryParameters: {
        if (statuses != null) 'status': statuses.join(','),
        if (hidden != null) 'hidden': '$hidden',
        'cursor': ?cursor,
      },
    );
    return MyPostsPage.fromJson(response.data!);
  });

  @override
  Future<MyPostCounts> counts() => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/posts/me/counts');
    return MyPostCounts.fromJson(response.data!);
  });

  @override
  Future<PostView> markSold(String id, {String? soldPrice}) =>
      _post('/posts/$id/sold', {'soldPrice': ?soldPrice});

  @override
  Future<PostView> repost(String id) => _post('/posts/$id/repost');

  @override
  Future<PostView> setHidden(String id, {required bool hidden}) =>
      _post('/posts/$id/${hidden ? 'hide' : 'unhide'}');

  @override
  Future<void> delete(String id) =>
      _call(() => _dio.delete<void>('/posts/$id'));

  @override
  Future<PostOwnership> ownership(double lat, double lng) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/posts/ownership',
      queryParameters: {'lat': lat, 'lng': lng},
    );
    return PostOwnership.fromJson(response.data!);
  });
}

final postsApiProvider = Provider<PostsApi>(
  (ref) => DioPostsApi(ref.watch(dioClientProvider)),
);

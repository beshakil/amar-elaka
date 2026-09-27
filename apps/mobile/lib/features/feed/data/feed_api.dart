import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../domain/feed_query.dart';

/// A page as parsed, plus the body as received (what the offline cache
/// stores for the first page).
typedef FeedFetch = ({FeedPage page, String rawJson});

/// GET /feed (ADR 035). Failures surface as [AppException].
abstract interface class FeedApi {
  Future<FeedFetch> page(
    FeedQuery query, {
    double? lat,
    double? lng,
    String? cursor,
  });
}

class DioFeedApi implements FeedApi {
  DioFeedApi(this._dio);

  final Dio _dio;

  @override
  Future<FeedFetch> page(
    FeedQuery query, {
    double? lat,
    double? lng,
    String? cursor,
  }) async {
    try {
      final response = await _dio.get<String>(
        '/feed',
        queryParameters: {
          'scope': query.scope.api,
          'category': ?query.categorySlug,
          'filters': ?query.filtersJson,
          if (lat != null && lng != null) ...{'lat': lat, 'lng': lng},
          'cursor': ?cursor,
        },
        options: Options(responseType: ResponseType.plain),
      );
      final raw = response.data!;
      return (
        page: FeedPage.fromJson(jsonDecode(raw) as Map<String, dynamic>),
        rawJson: raw,
      );
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }
}

final feedApiProvider = Provider<FeedApi>(
  (ref) => DioFeedApi(ref.watch(dioClientProvider)),
);

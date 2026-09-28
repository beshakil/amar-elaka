import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../domain/search_request.dart';

/// GET /search, /search/suggest, /search/trending and POST /search/click
/// (ADR 040). Failures surface as [AppException].
abstract interface class SearchApi {
  Future<SearchResult> search(
    SearchRequest request, {
    double? lat,
    double? lng,
    String? cursor,
  });

  Future<SuggestResult> suggest(String q, {double? lat, double? lng});

  Future<TrendingResult> trending();

  /// Best effort: which result the searcher opened (for ranking and demand).
  Future<void> click(String searchId, String postId);
}

class DioSearchApi implements SearchApi {
  DioSearchApi(this._dio);

  final Dio _dio;

  @override
  Future<SearchResult> search(
    SearchRequest request, {
    double? lat,
    double? lng,
    String? cursor,
  }) => _get(
    '/search',
    request.queryParameters(lat: lat, lng: lng, cursor: cursor),
    SearchResult.fromJson,
  );

  @override
  Future<SuggestResult> suggest(String q, {double? lat, double? lng}) =>
      _get('/search/suggest', {
        'q': q,
        if (lat != null && lng != null) ...{'lat': lat, 'lng': lng},
      }, SuggestResult.fromJson);

  @override
  Future<TrendingResult> trending() =>
      _get('/search/trending', const {}, TrendingResult.fromJson);

  @override
  Future<void> click(String searchId, String postId) async {
    try {
      await _dio.post<void>(
        '/search/click',
        data: {'searchId': searchId, 'postId': postId},
      );
    } on DioException {
      // A lost click costs a statistic, never the viewer's tap.
    }
  }

  Future<T> _get<T>(
    String path,
    Map<String, Object> query,
    T Function(Map<String, dynamic>) parse,
  ) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        path,
        queryParameters: query,
      );
      return parse(response.data!);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }
}

final searchApiProvider = Provider<SearchApi>(
  (ref) => DioSearchApi(ref.watch(dioClientProvider)),
);

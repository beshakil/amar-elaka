import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// A new saved search, as POST /saved-searches takes it (ADR 041).
class NewSavedSearch {
  const NewSavedSearch({
    required this.name,
    required this.q,
    required this.filters,
    required this.center,
    required this.radiusKm,
    required this.frequency,
  });

  final String name;
  final String q;
  final SavedSearchFilters filters;
  final LatLng center;
  final double radiusKm;
  final AlertFrequency frequency;

  Map<String, dynamic> toJson() => {
    'name': name,
    'q': q,
    'filters': filters.toRequestJson(),
    'center': center.toJson(),
    'radius_km': radiusKm,
    'frequency': frequency.api,
  };
}

/// /saved-searches (signed-in users only). Failures surface as [AppException].
abstract interface class SavedSearchesApi {
  Future<SavedSearchList> list();

  Future<SavedSearch> create(NewSavedSearch search);

  /// `active: true` also resumes an auto-paused search.
  Future<SavedSearch> setActive(String id, {required bool active});

  Future<void> delete(String id);

  /// The unseen matches; opening them marks them seen.
  Future<SavedSearchNewResults> newResults(String id);
}

class DioSavedSearchesApi implements SavedSearchesApi {
  DioSavedSearchesApi(this._dio);

  final Dio _dio;

  @override
  Future<SavedSearchList> list() async => SavedSearchList.fromJson(
    await _call(() => _dio.get<Map<String, dynamic>>('/saved-searches')),
  );

  @override
  Future<SavedSearch> create(NewSavedSearch search) async =>
      SavedSearch.fromJson(
        await _call(
          () => _dio.post<Map<String, dynamic>>(
            '/saved-searches',
            data: search.toJson(),
          ),
        ),
      );

  @override
  Future<SavedSearch> setActive(String id, {required bool active}) async =>
      SavedSearch.fromJson(
        await _call(
          () => _dio.patch<Map<String, dynamic>>(
            '/saved-searches/$id',
            data: {'active': active},
          ),
        ),
      );

  @override
  Future<void> delete(String id) async {
    try {
      await _dio.delete<void>('/saved-searches/$id');
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<SavedSearchNewResults> newResults(String id) async =>
      SavedSearchNewResults.fromJson(
        await _call(
          () =>
              _dio.get<Map<String, dynamic>>('/saved-searches/$id/new-results'),
        ),
      );

  Future<Map<String, dynamic>> _call(
    Future<Response<Map<String, dynamic>>> Function() request,
  ) async {
    try {
      return (await request()).data!;
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }
}

final savedSearchesApiProvider = Provider<SavedSearchesApi>(
  (ref) => DioSavedSearchesApi(ref.watch(dioClientProvider)),
);

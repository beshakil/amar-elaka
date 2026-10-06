import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/api_exception.dart';
import '../network/dio_client.dart';

/// Where-is-this lookups behind our API (ADR 044, 046). Barikoi is reached
/// only by apps/api; the app never holds its key or URL.
///   areasAt       our own administrative areas at a point (free, instant)
///   reverse       the street address for a [purpose] — settings decide
///                 which (billed) Barikoi fields that purpose may ask for
///   autocomplete  address search: our places first, then Barikoi
abstract interface class GeoApi {
  Future<PointAreas> areasAt(double lat, double lng);

  /// [purpose]: post_location | store_setup | place_marking.
  Future<ReverseGeocode> reverse(
    double lat,
    double lng, {
    required String purpose,
  });

  Future<GeocodeResponse> autocomplete(
    String query, {
    double? lat,
    double? lng,
  });
}

class DioGeoApi implements GeoApi {
  DioGeoApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<PointAreas> areasAt(double lat, double lng) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/locations/lookup',
      queryParameters: {'lat': lat, 'lng': lng},
    );
    return PointAreas.fromJson(response.data!);
  });

  @override
  Future<ReverseGeocode> reverse(
    double lat,
    double lng, {
    required String purpose,
  }) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/geo/reverse',
      queryParameters: {'lat': lat, 'lng': lng, 'purpose': purpose},
    );
    return ReverseGeocode.fromJson(response.data!);
  });

  @override
  Future<GeocodeResponse> autocomplete(
    String query, {
    double? lat,
    double? lng,
  }) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/geo/autocomplete',
      queryParameters: {'q': query, 'lat': ?lat, 'lng': ?lng},
    );
    return GeocodeResponse.fromJson(response.data!);
  });
}

final geoApiProvider = Provider<GeoApi>(
  (ref) => DioGeoApi(ref.watch(dioClientProvider)),
);

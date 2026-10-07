import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// `GET /map/offline` and `GET /map/offline/areas` (ADR 050) for the
/// current tenant (the client's X-Tenant-Id).
abstract interface class OfflineMapApi {
  Future<OfflineMapManifest> manifest();

  /// The tenant's area and the areas inside it, simplified, as GeoJSON.
  Future<Map<String, dynamic>> areas();
}

class DioOfflineMapApi implements OfflineMapApi {
  DioOfflineMapApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<OfflineMapManifest> manifest() => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/map/offline');
    return OfflineMapManifest.fromJson(response.data!);
  });

  @override
  Future<Map<String, dynamic>> areas() => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/map/offline/areas');
    return response.data!;
  });
}

final offlineMapApiProvider = Provider<OfflineMapApi>(
  (ref) => DioOfflineMapApi(ref.watch(dioClientProvider)),
);

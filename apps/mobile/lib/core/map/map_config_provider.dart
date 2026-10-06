import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/api_exception.dart';
import '../network/dio_client.dart';

/// The map's API (ADR 043, 044, 045):
///   config    which tiles archive is live, where its fonts and sprites are,
///             the label language and fallback style settings;
///   features  a viewport's posts, stores, places, landmarks and info as
///             GeoJSON from our own database, clustered by the API;
///   preview   one tapped feature's photo, public phones and address;
///   distance  straight-line metres (PostGIS, free);
///   route   the road route to a point — only ever on an explicit tap.
abstract interface class MapApi {
  Future<MapConfig> config();

  /// [kinds]: `map_kinds` codes to keep (null = every kind);
  /// [layers]: null = the server's default layers.
  Future<MapFeatures> features({
    required LatLngBox bbox,
    required double zoom,
    Set<String>? layers,
    Set<String>? kinds,
    bool openNow = false,
  });

  Future<MapPreview> preview({
    required String layer,
    required String id,
    required String tenantId,
  });

  Future<MapDistance> distance({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
  });

  Future<RouteAnswer> route({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
    required String mode,
  });
}

/// minLng,minLat,maxLng,maxLat — the order map libraries (and the API) use.
typedef LatLngBox = ({
  double minLng,
  double minLat,
  double maxLng,
  double maxLat,
});

class DioMapApi implements MapApi {
  DioMapApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<MapConfig> config() => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/map/config');
    return MapConfig.fromJson(response.data!);
  });

  @override
  Future<MapFeatures> features({
    required LatLngBox bbox,
    required double zoom,
    Set<String>? layers,
    Set<String>? kinds,
    bool openNow = false,
  }) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/map/features',
      queryParameters: {
        'bbox': [
          bbox.minLng,
          bbox.minLat,
          bbox.maxLng,
          bbox.maxLat,
        ].map((n) => n.toStringAsFixed(5)).join(','),
        'zoom': zoom,
        if (layers != null) 'layers': layers.join(','),
        if (kinds != null) 'kinds': kinds.join(','),
        if (openNow) 'open_now': 'true',
      },
    );
    return MapFeatures.fromJson(response.data!);
  });

  @override
  Future<MapPreview> preview({
    required String layer,
    required String id,
    required String tenantId,
  }) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/map/features/$layer/$id',
      queryParameters: {'tenant': tenantId},
    );
    return MapPreview.fromJson(response.data!);
  });

  @override
  Future<MapDistance> distance({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
  }) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/map/distance',
      queryParameters: {'from': '$fromLat,$fromLng', 'to': '$toLat,$toLng'},
    );
    return MapDistance.fromJson(response.data!);
  });

  @override
  Future<RouteAnswer> route({
    required double fromLat,
    required double fromLng,
    required double toLat,
    required double toLng,
    required String mode,
  }) => _call(() async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/geo/route',
      data: {
        'from': {'lat': fromLat, 'lng': fromLng},
        'to': {'lat': toLat, 'lng': toLng},
        'mode': mode,
      },
    );
    return RouteAnswer.fromJson(response.data!);
  });
}

final mapApiProvider = Provider<MapApi>(
  (ref) => DioMapApi(ref.watch(dioClientProvider)),
);

/// Loaded once per app run. A failure is an error state (the map shows a
/// notice; everything around it still works) and Riverpod retries it.
final mapConfigProvider = FutureProvider<MapConfig>(
  (ref) => ref.watch(mapApiProvider).config(),
);

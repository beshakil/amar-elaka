import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/map/location_picker.dart' show GeoPoint;
import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../../place_feedback/data/place_feedback_api.dart' show HoursRange;

/// A place as its screen shows it (`GET /places/:id`, the fields used here).
class PlaceDetail {
  const PlaceDetail({
    required this.id,
    required this.nameBn,
    required this.nameEn,
    required this.description,
    required this.status,
    required this.possiblyClosed,
    required this.fieldVerified,
    required this.claimed,
    required this.phones,
    required this.addressText,
    required this.location,
    required this.hours,
    required this.openState,
  });

  factory PlaceDetail.fromJson(Map<String, dynamic> json) {
    final location = json['location'] as Map<String, dynamic>;
    final claim = json['claim'] as Map<String, dynamic>;
    final open = json['openState'] as Map<String, dynamic>?;
    return PlaceDetail(
      id: json['id'] as String,
      nameBn: json['nameBn'] as String,
      nameEn: json['nameEn'] as String?,
      description: json['description'] as String?,
      status: json['status'] as String,
      possiblyClosed: json['possiblyClosed'] as bool? ?? false,
      fieldVerified: json['fieldVerified'] as bool? ?? false,
      claimed: claim['claimed'] as bool? ?? false,
      phones: [for (final p in json['phones'] as List) p as String],
      addressText: json['addressText'] as String?,
      location: (
        lat: (location['lat'] as num).toDouble(),
        lng: (location['lng'] as num).toDouble(),
      ),
      hours: [
        for (final h in json['businessHours'] as List)
          (
            day: (h as Map<String, dynamic>)['day'] as int,
            opens: h['opens'] as String,
            closes: h['closes'] as String,
          ),
      ],
      openState: open?['state'] as String?,
    );
  }

  /// Its id after a merge redirect may differ from the one asked for.
  final String id;
  final String nameBn;
  final String? nameEn;
  final String? description;

  /// published | temporarily_closed | permanently_closed | … (place_statuses).
  final String status;

  /// Enough members reported it closed for good; a moderator is checking.
  final bool possiblyClosed;
  final bool fieldVerified;

  /// An owner verified it (ADR 047).
  final bool claimed;

  /// E.164.
  final List<String> phones;
  final String? addressText;
  final GeoPoint location;

  /// The weekly schedule; empty when unknown.
  final List<HoursRange> hours;

  /// is_open_at() now: open | closes_soon | opens_soon | closed | unknown.
  final String? openState;
}

abstract interface class PlaceDetailApi {
  Future<PlaceDetail> place(String placeId);

  /// True when saved now, false when it already was (`POST /saved/place/:id`).
  Future<bool> save(String placeId);
}

class DioPlaceDetailApi implements PlaceDetailApi {
  DioPlaceDetailApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<PlaceDetail> place(String placeId) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/places/$placeId');
    return PlaceDetail.fromJson(response.data!);
  });

  @override
  Future<bool> save(String placeId) => _call(() async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/saved/place/$placeId',
    );
    return response.data?['created'] as bool? ?? response.statusCode == 201;
  });
}

final placeDetailApiProvider = Provider<PlaceDetailApi>(
  (ref) => DioPlaceDetailApi(ref.watch(dioClientProvider)),
);

/// One place, fetched when its screen opens.
final placeDetailProvider = FutureProvider.autoDispose
    .family<PlaceDetail, String>(
      (ref, placeId) => ref.watch(placeDetailApiProvider).place(placeId),
    );

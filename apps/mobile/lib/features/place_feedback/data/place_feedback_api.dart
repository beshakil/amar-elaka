import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/map/location_picker.dart' show GeoPoint;
import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

/// report_reasons a place takes (PLACE_REPORT_REASONS in
/// apps/api/src/places/dto/place-moderation.dto.ts).
const placeReportReasons = [
  'wrong_location',
  'closed_permanently',
  'duplicate',
  'wrong_information',
  'inappropriate',
];

/// One weekly opening range; `closes` at or before `opens` runs past midnight.
typedef HoursRange = ({int day, String opens, String closes});

/// What the suggest screen starts from: the place as it is now.
class PlaceSnapshot {
  const PlaceSnapshot({
    required this.id,
    required this.nameBn,
    required this.location,
    required this.phones,
    required this.hours,
  });

  /// From `GET /places/:id` (only the fields this feature uses).
  factory PlaceSnapshot.fromJson(Map<String, dynamic> json) {
    final location = json['location'] as Map<String, dynamic>;
    return PlaceSnapshot(
      id: json['id'] as String,
      nameBn: json['nameBn'] as String,
      location: (
        lat: (location['lat'] as num).toDouble(),
        lng: (location['lng'] as num).toDouble(),
      ),
      phones: [for (final p in json['phones'] as List) p as String],
      hours: [
        for (final h in json['businessHours'] as List)
          (
            day: (h as Map<String, dynamic>)['day'] as int,
            opens: h['opens'] as String,
            closes: h['closes'] as String,
          ),
      ],
    );
  }

  final String id;
  final String nameBn;
  final GeoPoint location;

  /// E.164.
  final List<String> phones;
  final List<HoursRange> hours;
}

/// A member's side of map moderation (ADR 051): report a place, or suggest
/// a location / phones / weekly hours a moderator then approves. Failures
/// surface as [AppException]; the screens word its code.
abstract interface class PlaceFeedbackApi {
  Future<PlaceSnapshot> place(String placeId);

  /// [duplicateOf]: with `duplicate`, the place this one duplicates.
  Future<void> report(
    String placeId,
    String reasonCode,
    String? text, {
    String? duplicateOf,
  });

  /// Only the fields the member changed; at least one.
  Future<void> suggest(
    String placeId, {
    GeoPoint? location,
    List<String>? phones,
    List<HoursRange>? hours,
    String? note,
  });
}

class DioPlaceFeedbackApi implements PlaceFeedbackApi {
  DioPlaceFeedbackApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<PlaceSnapshot> place(String placeId) => _call(() async {
    final response = await _dio.get<Map<String, dynamic>>('/places/$placeId');
    return PlaceSnapshot.fromJson(response.data!);
  });

  @override
  Future<void> report(
    String placeId,
    String reasonCode,
    String? text, {
    String? duplicateOf,
  }) => _call(() async {
    await _dio.post<void>(
      '/places/$placeId/report',
      data: {
        'reasonCode': reasonCode,
        if (text != null && text.trim().isNotEmpty) 'text': text.trim(),
        'duplicateOfPlaceId': ?duplicateOf,
      },
    );
  });

  @override
  Future<void> suggest(
    String placeId, {
    GeoPoint? location,
    List<String>? phones,
    List<HoursRange>? hours,
    String? note,
  }) => _call(() async {
    await _dio.post<void>(
      '/places/$placeId/suggestions',
      data: {
        if (location != null)
          'location': {'lat': location.lat, 'lng': location.lng},
        'phones': ?phones,
        if (hours != null)
          'hours': [
            for (final h in hours)
              {'day': h.day, 'opens': h.opens, 'closes': h.closes},
          ],
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      },
    );
  });
}

final placeFeedbackApiProvider = Provider<PlaceFeedbackApi>(
  (ref) => DioPlaceFeedbackApi(ref.watch(dioClientProvider)),
);

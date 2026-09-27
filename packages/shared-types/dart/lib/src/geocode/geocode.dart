import 'package:json_annotation/json_annotation.dart';

import '../tenants/lat_lng.dart';

part 'geocode.g.dart';

/// Mirrors `GeocodeResultDto` (apps/api/src/locations/dto/locations.dto.ts).
@JsonSerializable()
class GeocodeResult {
  const GeocodeResult({
    required this.label,
    required this.labelBn,
    required this.location,
    required this.area,
    required this.city,
    required this.source,
    required this.distanceMeters,
  });

  factory GeocodeResult.fromJson(Map<String, dynamic> json) =>
      _$GeocodeResultFromJson(json);

  final String label;
  final String? labelBn;
  final LatLng location;
  final String? area;
  final String? city;

  /// provider | local
  final String source;
  final double? distanceMeters;

  Map<String, dynamic> toJson() => _$GeocodeResultToJson(this);
}

/// `GET /geocode/forward` and `GET /geocode/autocomplete`.
@JsonSerializable()
class GeocodeResponse {
  const GeocodeResponse({
    required this.query,
    required this.results,
    required this.degraded,
  });

  factory GeocodeResponse.fromJson(Map<String, dynamic> json) =>
      _$GeocodeResponseFromJson(json);

  final String query;
  final List<GeocodeResult> results;

  /// The provider was down: results come from our own area data only.
  final bool degraded;

  Map<String, dynamic> toJson() => _$GeocodeResponseToJson(this);
}

/// `GET /geocode/reverse`.
@JsonSerializable()
class ReverseGeocode {
  const ReverseGeocode({
    required this.location,
    required this.address,
    required this.areas,
    required this.degraded,
  });

  factory ReverseGeocode.fromJson(Map<String, dynamic> json) =>
      _$ReverseGeocodeFromJson(json);

  final LatLng location;
  final GeocodeResult? address;

  /// Our own administrative areas at the point, country first.
  final List<GeoArea> areas;
  final bool degraded;

  Map<String, dynamic> toJson() => _$ReverseGeocodeToJson(this);
}

@JsonSerializable()
class GeoArea {
  const GeoArea({required this.id, required this.level, required this.name});

  factory GeoArea.fromJson(Map<String, dynamic> json) =>
      _$GeoAreaFromJson(json);

  final String id;

  /// country / division / district / upazila / union / …
  final String level;
  final GeoAreaName name;

  Map<String, dynamic> toJson() => _$GeoAreaToJson(this);
}

@JsonSerializable()
class GeoAreaName {
  const GeoAreaName({required this.bn, required this.en});

  factory GeoAreaName.fromJson(Map<String, dynamic> json) =>
      _$GeoAreaNameFromJson(json);

  final String? bn;
  final String en;

  String of(String locale) => locale == 'bn' ? (bn ?? en) : en;

  Map<String, dynamic> toJson() => _$GeoAreaNameToJson(this);
}

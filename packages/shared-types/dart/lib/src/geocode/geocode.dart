import 'package:json_annotation/json_annotation.dart';

import '../tenants/lat_lng.dart';

part 'geocode.g.dart';

/// Mirrors a `GeoAutocompleteResponseDto` result (apps/api/src/locations/geocoding/geo.dto.ts).
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
    this.kind = 'address',
    this.refId,
  });

  factory GeocodeResult.fromJson(Map<String, dynamic> json) =>
      _$GeocodeResultFromJson(json);

  final String label;
  final String? labelBn;
  final LatLng location;
  final String? area;
  final String? city;

  /// own (our places, landmarks, stores, areas) | barikoi (show its credit)
  final String source;
  final double? distanceMeters;

  /// landmark | place | store (our directory) | area (our geo_areas) | address (Barikoi's).
  @JsonKey(defaultValue: 'address')
  final String kind;

  /// Our place's or store's id; null for an area or a Barikoi address.
  final String? refId;

  Map<String, dynamic> toJson() => _$GeocodeResultToJson(this);
}

/// `GET /geo/autocomplete` (ADR 044): our own results first.
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

  /// Barikoi was needed but not used (budget, breaker, disabled): own results only.
  final bool degraded;

  Map<String, dynamic> toJson() => _$GeocodeResponseToJson(this);
}

/// `GET /geo/reverse` (ADR 044): our own areas always; a Barikoi street
/// address only for a purpose that shows one (`post_location`,
/// `store_setup`, `place_marking`), with only the fields settings map to it.
@JsonSerializable()
class ReverseGeocode {
  const ReverseGeocode({
    required this.location,
    required this.address,
    required this.areas,
    required this.degraded,
    this.purpose = 'area',
  });

  factory ReverseGeocode.fromJson(Map<String, dynamic> json) =>
      _$ReverseGeocodeFromJson(json);

  final LatLng location;

  /// area | post_location | store_setup | place_marking
  @JsonKey(defaultValue: 'area')
  final String purpose;
  final GeoAddress? address;

  /// Our own administrative areas at the point, country first.
  final List<GeoArea> areas;
  final bool degraded;

  Map<String, dynamic> toJson() => _$ReverseGeocodeToJson(this);
}

/// A Barikoi street address (show its credit).
@JsonSerializable()
class GeoAddress {
  const GeoAddress({
    required this.label,
    required this.labelBn,
    this.area,
    this.city,
    this.postCode,
    this.source = 'barikoi',
  });

  factory GeoAddress.fromJson(Map<String, dynamic> json) =>
      _$GeoAddressFromJson(json);

  final String label;
  final String? labelBn;
  final String? area;
  final String? city;
  final String? postCode;
  @JsonKey(defaultValue: 'barikoi')
  final String source;

  Map<String, dynamic> toJson() => _$GeoAddressToJson(this);
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

/// `GET /locations/lookup`: our own administrative areas at a point (no
/// provider, no cost) — what LocationPicker shows at once, before the
/// street address arrives.
@JsonSerializable(explicitToJson: true)
class PointAreas {
  const PointAreas({required this.areas});

  factory PointAreas.fromJson(Map<String, dynamic> json) =>
      _$PointAreasFromJson(json);

  /// Country first.
  final List<GeoArea> areas;

  Map<String, dynamic> toJson() => _$PointAreasToJson(this);
}

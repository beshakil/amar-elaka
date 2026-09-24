import 'package:json_annotation/json_annotation.dart';

part 'lat_lng.g.dart';

/// Mirrors the `{ lat, lng }` shape used for `mapCenter` throughout
/// `apps/api/src/tenants/tenants.service.ts`.
@JsonSerializable()
class LatLng {
  const LatLng({required this.lat, required this.lng});

  factory LatLng.fromJson(Map<String, dynamic> json) => _$LatLngFromJson(json);

  final double lat;
  final double lng;

  Map<String, dynamic> toJson() => _$LatLngToJson(this);
}

import 'package:json_annotation/json_annotation.dart';

import 'lat_lng.dart';

part 'tenant_summary.g.dart';

/// Mirrors `TenantSummary` (apps/api/src/tenants/tenants.service.ts) — the
/// body of `GET /tenants` and `GET /tenants/nearby`, used for the tenant
/// picker. `districtName*` is the ADM2 ancestor of the tenant's own
/// (upazila/ADM3) geo area — null for a tenant whose area has no district
/// ancestor on record.
@JsonSerializable()
class TenantSummary {
  const TenantSummary({
    required this.id,
    required this.slug,
    required this.nameBn,
    required this.nameEn,
    required this.mapCenter,
    required this.districtNameBn,
    required this.districtNameEn,
  });

  factory TenantSummary.fromJson(Map<String, dynamic> json) =>
      _$TenantSummaryFromJson(json);

  final String id;
  final String slug;
  final String nameBn;
  final String nameEn;
  final LatLng mapCenter;
  final String? districtNameBn;
  final String? districtNameEn;

  Map<String, dynamic> toJson() => _$TenantSummaryToJson(this);
}

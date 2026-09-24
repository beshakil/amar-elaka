import 'package:json_annotation/json_annotation.dart';

import 'lat_lng.dart';

part 'tenant_config.g.dart';

/// Mirrors `TenantConfig` (apps/api/src/tenants/tenants.service.ts) — the
/// body of `GET /tenant/config`, cached locally after tenant bootstrap.
@JsonSerializable()
class TenantConfig {
  const TenantConfig({
    required this.id,
    required this.slug,
    required this.nameBn,
    required this.nameEn,
    required this.defaultLocale,
    required this.mapCenter,
    required this.radiusKm,
    required this.branding,
    required this.featureFlags,
    required this.enabledCategories,
    required this.emergencyNumbers,
    required this.support,
  });

  factory TenantConfig.fromJson(Map<String, dynamic> json) =>
      _$TenantConfigFromJson(json);

  final String id;
  final String slug;
  final String nameBn;
  final String nameEn;
  final String defaultLocale;
  final LatLng mapCenter;
  final double? radiusKm;
  final TenantBranding branding;
  final Map<String, dynamic> featureFlags;
  final List<TenantCategory> enabledCategories;
  final List<EmergencyNumber> emergencyNumbers;
  final TenantSupport support;

  Map<String, dynamic> toJson() => _$TenantConfigToJson(this);
}

@JsonSerializable()
class TenantBranding {
  const TenantBranding({required this.logoStorageKey});

  factory TenantBranding.fromJson(Map<String, dynamic> json) =>
      _$TenantBrandingFromJson(json);

  final String? logoStorageKey;

  Map<String, dynamic> toJson() => _$TenantBrandingToJson(this);
}

@JsonSerializable()
class TenantCategory {
  const TenantCategory({
    required this.slug,
    required this.nameBn,
    required this.nameEn,
    required this.iconKey,
  });

  factory TenantCategory.fromJson(Map<String, dynamic> json) =>
      _$TenantCategoryFromJson(json);

  final String slug;
  final String nameBn;
  final String nameEn;
  final String? iconKey;

  Map<String, dynamic> toJson() => _$TenantCategoryToJson(this);
}

@JsonSerializable()
class EmergencyNumber {
  const EmergencyNumber({
    required this.serviceType,
    required this.nameBn,
    required this.nameEn,
    required this.phones,
    required this.is24h,
  });

  factory EmergencyNumber.fromJson(Map<String, dynamic> json) =>
      _$EmergencyNumberFromJson(json);

  final String serviceType;
  final String nameBn;
  final String? nameEn;
  final List<String> phones;
  final bool is24h;

  Map<String, dynamic> toJson() => _$EmergencyNumberToJson(this);
}

@JsonSerializable()
class TenantSupport {
  const TenantSupport({
    required this.phoneE164,
    required this.email,
    required this.whatsappE164,
  });

  factory TenantSupport.fromJson(Map<String, dynamic> json) =>
      _$TenantSupportFromJson(json);

  final String? phoneE164;
  final String? email;
  final String? whatsappE164;

  Map<String, dynamic> toJson() => _$TenantSupportToJson(this);
}

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
    this.moderation = TenantModeration.fallback,
    this.media = TenantMedia.fallback,
    this.timezone = TenantTimezone.fallback,
    this.search = TenantSearch.fallback,
    this.places = TenantPlaces.fallback,
    this.client = TenantClient.fallback,
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

  /// Defaults for a response from before the field existed.
  final TenantModeration moderation;

  /// The photo limits the picker and the compressor must match; defaults for
  /// a config cached before the field existed.
  final TenantMedia media;

  /// The tenant's zone: what "today" is for date fields.
  final TenantTimezone timezone;

  /// search_suggest_min_chars.
  final TenantSearch search;

  /// duplicate_report_radius_m.
  final TenantPlaces places;

  /// How long this config may be served from the phone's cache.
  final TenantClient client;

  Map<String, dynamic> toJson() => _$TenantConfigToJson(this);
}

@JsonSerializable()
class TenantModeration {
  const TenantModeration({required this.typicalReviewHours});

  /// The seeded default (moderation_typical_review_hours, 0029), for a
  /// config cached or served before the field existed.
  static const fallback = TenantModeration(typicalReviewHours: 12);

  factory TenantModeration.fromJson(Map<String, dynamic> json) =>
      _$TenantModerationFromJson(json);

  /// "Under review, usually within X hours" (moderation_typical_review_hours).
  final int typicalReviewHours;

  Map<String, dynamic> toJson() => _$TenantModerationToJson(this);
}

@JsonSerializable()
class TenantMedia {
  const TenantMedia({
    required this.postMaxPhotos,
    required this.imageMaxLongEdgePx,
    this.imageQuality = 80,
  });

  /// The seeded defaults (post_max_media 0026, media_variant_full_px and
  /// media_image_quality 0019), for a config cached or served before the
  /// field existed.
  static const fallback = TenantMedia(
    postMaxPhotos: 10,
    imageMaxLongEdgePx: 1200,
  );

  factory TenantMedia.fromJson(Map<String, dynamic> json) =>
      _$TenantMediaFromJson(json);

  /// post_max_media: the API refuses a post with more.
  final int postMaxPhotos;

  /// media_variant_full_px: the largest variant the server keeps; uploading
  /// bigger only wastes the user's data.
  final int imageMaxLongEdgePx;

  /// media_image_quality (0-100): the quality the server re-encodes at, so a
  /// higher one on the phone only costs the user's data.
  final int imageQuality;

  Map<String, dynamic> toJson() => _$TenantMediaToJson(this);
}

@JsonSerializable()
class TenantTimezone {
  const TenantTimezone({required this.name, required this.utcOffsetMinutes});

  /// Every tenant so far is in Bangladesh: Asia/Dhaka, UTC+6, no daylight
  /// saving. For a config cached or served before the field existed.
  static const fallback = TenantTimezone(
    name: 'Asia/Dhaka',
    utcOffsetMinutes: 360,
  );

  factory TenantTimezone.fromJson(Map<String, dynamic> json) =>
      _$TenantTimezoneFromJson(json);

  /// tenants.timezone (IANA).
  final String name;

  /// The zone's offset from UTC when the config was served.
  final int utcOffsetMinutes;

  Duration get utcOffset => Duration(minutes: utcOffsetMinutes);

  Map<String, dynamic> toJson() => _$TenantTimezoneToJson(this);
}

@JsonSerializable()
class TenantSearch {
  const TenantSearch({required this.suggestMinChars});

  /// The seeded search_suggest_min_chars (0020).
  static const fallback = TenantSearch(suggestMinChars: 2);

  factory TenantSearch.fromJson(Map<String, dynamic> json) =>
      _$TenantSearchFromJson(json);

  /// Shorter text asks the server for no suggestions.
  final int suggestMinChars;

  Map<String, dynamic> toJson() => _$TenantSearchToJson(this);
}

@JsonSerializable()
class TenantPlaces {
  const TenantPlaces({required this.duplicateReportRadiusM});

  /// The seeded duplicate_report_radius_m (0046).
  static const fallback = TenantPlaces(duplicateReportRadiusM: 1000);

  factory TenantPlaces.fromJson(Map<String, dynamic> json) =>
      _$TenantPlacesFromJson(json);

  /// How far the other place in a "same place" report may be.
  final int duplicateReportRadiusM;

  Map<String, dynamic> toJson() => _$TenantPlacesToJson(this);
}

@JsonSerializable()
class TenantClient {
  const TenantClient({required this.configRefreshMinutes});

  /// The seeded client_config_refresh_minutes (0049).
  static const fallback = TenantClient(configRefreshMinutes: 360);

  factory TenantClient.fromJson(Map<String, dynamic> json) =>
      _$TenantClientFromJson(json);

  /// A cached config older than this is refreshed in the background.
  final int configRefreshMinutes;

  Duration get configRefresh => Duration(minutes: configRefreshMinutes);

  Map<String, dynamic> toJson() => _$TenantClientToJson(this);
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

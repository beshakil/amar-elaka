import 'package:json_annotation/json_annotation.dart';

part 'map_features.g.dart';

/// The map layers, in the API's order (settings `map_layers_default`).
const mapLayers = ['posts', 'stores', 'places', 'landmarks', 'info'];

/// Mirrors `MapFeaturesResponseDto` (apps/api/src/map/map-features.dto.ts):
/// `GET /map/features`, a viewport's public points as a GeoJSON
/// FeatureCollection from our own database, clustered by the API below
/// `map_cluster_until_zoom` (ADR 045). Field names are the API's snake_case.
@JsonSerializable(fieldRename: FieldRename.snake)
class MapFeatures {
  const MapFeatures({
    required this.zoom,
    required this.layers,
    required this.clustered,
    required this.clipped,
    required this.truncated,
    required this.openNowSkipped,
    required this.features,
    this.type = 'FeatureCollection',
  });

  factory MapFeatures.fromJson(Map<String, dynamic> json) =>
      _$MapFeaturesFromJson(json);

  final String type;
  final int zoom;
  final List<String> layers;

  /// False from `map_cluster_until_zoom` on: every feature is a point.
  final bool clustered;

  /// The viewport reaches past `map_viewport_max_radius_km`: zoom in for more.
  final bool clipped;

  /// `map_features_max` was reached: the biggest clusters, then the nearest points, were kept.
  final bool truncated;

  /// With `open_now`: layers without opening hours, left out.
  final List<String> openNowSkipped;
  final List<MapFeature> features;

  Map<String, dynamic> toJson() => _$MapFeaturesToJson(this);
}

/// One GeoJSON Feature: a cluster ([MapFeatureProperties.cluster]) or a point.
@JsonSerializable(explicitToJson: true, includeIfNull: false)
class MapFeature {
  const MapFeature({
    required this.geometry,
    required this.properties,
    this.id,
    this.type = 'Feature',
  });

  factory MapFeature.fromJson(Map<String, dynamic> json) =>
      _$MapFeatureFromJson(json);

  final String type;

  /// Points only: the post/store/place/info id.
  final String? id;
  final MapPointGeometry geometry;
  final MapFeatureProperties properties;

  double get lng => geometry.coordinates[0];
  double get lat => geometry.coordinates[1];
  bool get isCluster => properties.cluster;

  Map<String, dynamic> toJson() => _$MapFeatureToJson(this);
}

@JsonSerializable()
class MapPointGeometry {
  const MapPointGeometry({required this.coordinates, this.type = 'Point'});

  factory MapPointGeometry.fromJson(Map<String, dynamic> json) =>
      _$MapPointGeometryFromJson(json);

  final String type;

  /// [lng, lat]
  final List<double> coordinates;

  Map<String, dynamic> toJson() => _$MapPointGeometryToJson(this);
}

/// A cluster has [count] and [expansionZoom]; a point has the rest. Both
/// [nameBn] and [nameEn] are always sent (null when unknown).
@JsonSerializable(fieldRename: FieldRename.snake, includeIfNull: false)
class MapFeatureProperties {
  const MapFeatureProperties({
    required this.cluster,
    required this.layer,
    this.kind,
    this.count,
    this.expansionZoom,
    this.id,
    this.tenantId,
    this.nameBn,
    this.nameEn,
    this.categorySlug,
    this.price,
    this.slug,
    this.infoKind,
    this.openNow,
  });

  factory MapFeatureProperties.fromJson(Map<String, dynamic> json) =>
      _$MapFeaturePropertiesFromJson(json);

  final bool cluster;

  /// posts | stores | places | landmarks | info
  final String layer;

  /// `map_kinds` code (the pin's icon); null when the feature matches none.
  final String? kind;
  final int? count;

  /// Zoom to go to on a tap: the cluster splits there (or every point shows).
  final int? expansionZoom;
  final String? id;
  final String? tenantId;
  final String? nameBn;
  final String? nameEn;
  final String? categorySlug;

  /// Posts: money string with two decimals.
  final String? price;
  final String? slug;

  /// info: the emergency service type, bus_stop, or a place category slug
  /// from `map_info_place_categories` (bank-atm).
  final String? infoKind;

  /// Places/landmarks by their hours, 24h info as true; null when unknown.
  final bool? openNow;

  Map<String, dynamic> toJson() => _$MapFeaturePropertiesToJson(this);
}

/// Mirrors `MapPreviewResponseDto`: `GET /map/features/:layer/:id?tenant=`,
/// what the preview sheet adds to a tapped feature (ADR 046).
@JsonSerializable(explicitToJson: true)
class MapPreview {
  const MapPreview({
    required this.layer,
    required this.id,
    required this.tenantId,
    required this.name,
    required this.photo,
    required this.phones,
    required this.address,
  });

  factory MapPreview.fromJson(Map<String, dynamic> json) =>
      _$MapPreviewFromJson(json);

  final String layer;
  final String id;
  final String tenantId;
  final MapName name;

  /// Card-size cover and its thumbhash; null when there is none.
  final MapPreviewPhoto? photo;

  /// Public numbers. Always empty for a post: calling goes through the
  /// post's contact action (lead tracking).
  final List<String> phones;
  final String? address;

  Map<String, dynamic> toJson() => _$MapPreviewToJson(this);
}

@JsonSerializable()
class MapName {
  const MapName({required this.bn, required this.en});

  factory MapName.fromJson(Map<String, dynamic> json) =>
      _$MapNameFromJson(json);

  final String? bn;
  final String? en;

  Map<String, dynamic> toJson() => _$MapNameToJson(this);
}

@JsonSerializable()
class MapPreviewPhoto {
  const MapPreviewPhoto({required this.url, required this.thumbhash});

  factory MapPreviewPhoto.fromJson(Map<String, dynamic> json) =>
      _$MapPreviewPhotoFromJson(json);

  final String url;
  final String? thumbhash;

  Map<String, dynamic> toJson() => _$MapPreviewPhotoToJson(this);
}

/// Mirrors `MapDistanceResponseDto`: `GET /map/distance` (PostGIS, free).
@JsonSerializable()
class MapDistance {
  const MapDistance({required this.straightLineMeters});

  factory MapDistance.fromJson(Map<String, dynamic> json) =>
      _$MapDistanceFromJson(json);

  @JsonKey(name: 'straight_line_meters')
  final double straightLineMeters;

  Map<String, dynamic> toJson() => _$MapDistanceToJson(this);
}

/// Mirrors `GeoRouteResponseDto`: `POST /geo/route`, asked for on a tap only.
@JsonSerializable()
class RouteAnswer {
  const RouteAnswer({
    required this.mode,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.polyline,
    required this.source,
    required this.degraded,
  });

  factory RouteAnswer.fromJson(Map<String, dynamic> json) =>
      _$RouteAnswerFromJson(json);

  /// car | foot
  final String mode;
  final double distanceMeters;

  /// Null when degraded: no made-up travel time.
  final double? durationSeconds;

  /// The road as GeoJSON LineString coordinates ([lng, lat] pairs); null when degraded.
  final List<List<double>>? polyline;

  /// barikoi (show its credit) | straight_line (PostGIS distance only)
  final String source;
  final bool degraded;

  Map<String, dynamic> toJson() => _$RouteAnswerToJson(this);
}

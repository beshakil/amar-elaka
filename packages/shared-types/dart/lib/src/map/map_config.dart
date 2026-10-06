import 'package:json_annotation/json_annotation.dart';

part 'map_config.g.dart';

/// Mirrors `MapConfigDto` (apps/api/src/map/map-config.dto.ts):
/// `GET /map/config`, what the app needs to draw the self-hosted base map
/// (docs/decisions/043-self-hosted-pmtiles-basemap.md).
@JsonSerializable()
class MapConfig {
  const MapConfig({
    required this.tiles,
    required this.assetsBaseUrl,
    required this.labelLanguage,
    required this.fallbackStyleUrl,
  });

  factory MapConfig.fromJson(Map<String, dynamic> json) =>
      _$MapConfigFromJson(json);

  /// Null until the server has built its tiles: show no base map, not an error.
  final MapTiles? tiles;

  /// Base for the style's fonts (glyphs, Bengali font files) and sprites.
  final String assetsBaseUrl;

  /// `map_label_language`: bn | en.
  final String labelLanguage;

  /// `map_style_fallback`, null when disabled. Emergency only: a Barikoi
  /// style costs 4 Barikoi API calls per map load.
  final String? fallbackStyleUrl;

  Map<String, dynamic> toJson() => _$MapConfigToJson(this);
}

/// The live versioned `.pmtiles` archive.
@JsonSerializable()
class MapTiles {
  const MapTiles({
    required this.url,
    required this.version,
    required this.maxZoom,
    required this.bounds,
  });

  factory MapTiles.fromJson(Map<String, dynamic> json) =>
      _$MapTilesFromJson(json);

  /// Absolute URL of the archive; MapLibre reads it as `pmtiles://<url>`.
  final String url;
  final String version;
  final int maxZoom;

  /// [minLng, minLat, maxLng, maxLat].
  final List<double> bounds;

  Map<String, dynamic> toJson() => _$MapTilesToJson(this);
}

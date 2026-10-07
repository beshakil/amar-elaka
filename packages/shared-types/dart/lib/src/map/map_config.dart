import 'package:json_annotation/json_annotation.dart';

part 'map_config.g.dart';

/// Mirrors `MapConfigDto` (apps/api/src/map/map-config.dto.ts):
/// `GET /map/config`, what the app needs to draw the self-hosted base map
/// (docs/decisions/043-self-hosted-pmtiles-basemap.md).
@JsonSerializable(explicitToJson: true)
class MapConfig {
  const MapConfig({
    required this.tiles,
    required this.assetsBaseUrl,
    required this.labelLanguage,
    required this.kinds,
    required this.client,
  });

  factory MapConfig.fromJson(Map<String, dynamic> json) =>
      _$MapConfigFromJson(json);

  /// Null until the server has built its tiles: show no base map, not an error.
  final MapTiles? tiles;

  /// Base for the style's fonts (glyphs, Bengali font files) and sprites.
  final String assetsBaseUrl;

  /// `map_label_language`: bn | en.
  final String labelLanguage;

  /// `map_kinds`: the Map tab's toggles, in order (ADR 046).
  final List<MapKind> kinds;

  /// The app's map timings and limits, from settings: none is hardcoded.
  final MapClientConfig client;

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

/// One Map tab toggle: features of these sources (server-side, `map_kinds`).
@JsonSerializable(explicitToJson: true)
class MapKind {
  const MapKind({required this.code, required this.icon, required this.label});

  factory MapKind.fromJson(Map<String, dynamic> json) =>
      _$MapKindFromJson(json);

  /// What `GET /map/features?kinds=` takes and each feature's `kind` carries.
  final String code;

  /// An icon key the app maps to its own icon (hospital, pharmacy, food, gas,
  /// bank, bus, shop, listing; anything else gets a generic pin).
  final String icon;
  final MapKindLabel label;

  Map<String, dynamic> toJson() => _$MapKindToJson(this);
}

@JsonSerializable()
class MapKindLabel {
  const MapKindLabel({required this.bn, required this.en});

  factory MapKindLabel.fromJson(Map<String, dynamic> json) =>
      _$MapKindLabelFromJson(json);

  final String bn;
  final String en;

  Map<String, dynamic> toJson() => _$MapKindLabelToJson(this);
}

/// Settings the app's map screens obey (GET /map/config `client`).
@JsonSerializable()
class MapClientConfig {
  const MapClientConfig({
    required this.pickerIdleDebounceMs,
    required this.autocompleteDebounceMs,
    required this.autocompleteMinChars,
    required this.searchAreaMoveRatio,
    required this.pinLabelMinZoom,
    required this.pinLabelMax,
  });

  factory MapClientConfig.fromJson(Map<String, dynamic> json) =>
      _$MapClientConfigFromJson(json);

  /// `geo_picker_idle_debounce_ms`: LocationPicker looks a point up only
  /// after the map has been still this long.
  final int pickerIdleDebounceMs;

  /// `geo_autocomplete_debounce_ms`
  final int autocompleteDebounceMs;

  /// `geocode_autocomplete_min_chars`: shorter queries are not sent.
  final int autocompleteMinChars;

  /// `map_search_area_move_ratio`: the share of the viewport moved before
  /// "Search this area" shows.
  final double searchAreaMoveRatio;

  /// `map_pin_label_min_zoom` / `map_pin_label_max`.
  final int pinLabelMinZoom;
  final int pinLabelMax;

  Duration get pickerIdleDebounce =>
      Duration(milliseconds: pickerIdleDebounceMs);
  Duration get autocompleteDebounce =>
      Duration(milliseconds: autocompleteDebounceMs);

  Map<String, dynamic> toJson() => _$MapClientConfigToJson(this);
}

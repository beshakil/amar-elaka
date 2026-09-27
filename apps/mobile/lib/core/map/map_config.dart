/// Map tiles for every map in the app, from build-time `--dart-define`s —
/// never a URL in widget code, so the provider (OSM in development; a keyed
/// provider such as Barikoi or MapTiler in production) changes without a
/// code change. docs/decisions/032-mobile-post-flows.md.
abstract final class MapConfig {
  /// `{z}/{x}/{y}` raster tiles. The default is OpenStreetMap's public
  /// server: fine for development, not for production traffic (its tile
  /// usage policy) — release builds pass their provider's URL.
  static const String tileUrl = String.fromEnvironment(
    'MAP_TILE_URL',
    defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );

  /// Shown on the map, as every tile provider's licence requires.
  static const String attribution = String.fromEnvironment(
    'MAP_ATTRIBUTION',
    defaultValue: '© OpenStreetMap contributors',
  );

  /// Sent with tile requests (OSM asks every app to identify itself).
  static const String userAgentPackageName = 'com.amarelaka.app';
}

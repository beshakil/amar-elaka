/// The one map for every client — the app, web and admin (mirrors
/// packages/shared-types/src/map.ts): OpenStreetMap's standard raster tiles.
/// Free, no key. docs/decisions/033-openstreetmap-maps.md.
///
/// OSM's tile usage policy is the price, and every map here keeps it: the
/// attribution is always shown, requests carry the app's User-Agent, and
/// nothing prefetches or bulk-downloads tiles.
abstract final class MapConfig {
  static const String tileUrl =
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  /// Required on every map.
  static const String attribution = '© OpenStreetMap contributors';
  static const String copyrightUrl = 'https://www.openstreetmap.org/copyright';

  /// Sent with every tile request: OSM blocks apps that don't identify themselves.
  static const String userAgentPackageName = 'com.amarelaka.app';

  /// OSM serves no tiles past this zoom.
  static const int maxZoom = 19;
}

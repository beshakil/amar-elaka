/**
 * The one map for every client — web, admin and the Flutter app
 * (apps/mobile/lib/core/map/map_config.dart mirrors these values): OpenStreetMap's
 * standard raster tiles. Free, no key. docs/decisions/033-openstreetmap-maps.md.
 *
 * OSM's tile usage policy (https://operations.osmfoundation.org/policies/tiles/)
 * is the price: show the attribution below on every map, send a real
 * User-Agent / Referer, don't prefetch or bulk-download tiles, and keep the
 * browser/HTTP cache on.
 */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** OSM serves no tiles past this zoom. */
export const OSM_MAX_ZOOM = 19;

/** Required on every map; link it to OSM_COPYRIGHT_URL. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

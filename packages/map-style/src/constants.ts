/** The base map's vector source id in every style. */
export const MAP_SOURCE_ID = 'protomaps';

/** Filled by resolveStyle() from GET /map/config: the versioned archive URL. */
export const TILES_PLACEHOLDER = '__TILES__';
/** Filled by resolveStyle(): where fonts/ and sprites/ are served (next to the archive). */
export const ASSETS_PLACEHOLDER = '__ASSETS__';

/** Marks a symbol layer whose text is a place/road/water name, re-labelled per language. */
export const LABEL_METADATA_KEY = 'amar-elaka:label';

/**
 * Required on every map (ODbL; Protomaps' basemap licence). A legal credit in
 * its fixed wording, so it is data in the style, not a translated UI string.
 * MapLibre's attribution control shows it on web; the Flutter app shows the
 * same credit as visible text (MapAttribution).
 */
export const MAP_ATTRIBUTION_HTML =
  '<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>';

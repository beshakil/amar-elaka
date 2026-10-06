import { z } from 'zod';
import { createZodDto } from '../common/pipes/zod-dto';

// settings-exempt: a bbox has four numbers (minLng,minLat,maxLng,maxLat)
const BBOX_PARTS = 4;
const bbox = z.array(z.number()).length(BBOX_PARTS);

/**
 * `current.json`, written by scripts/map/build-tiles.sh next to the archive:
 * which versioned .pmtiles file is live.
 */
export const tilesManifestSchema = z.object({
  version: z.string().regex(/^[0-9A-Za-z._-]+$/),
  file: z.string().regex(/^[0-9A-Za-z._-]+\.pmtiles$/),
  maxZoom: z.number().int().nonnegative(),
  bbox,
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  source: z.string(),
  builtAt: z.string(),
});
export type TilesManifest = z.infer<typeof tilesManifestSchema>;

export const mapConfigSchema = z.object({
  /** null until build-tiles.sh has run on this server: show no base map, not an error. */
  tiles: z
    .object({
      /** Absolute URL of the versioned archive; MapLibre reads it as `pmtiles://<url>`. */
      url: z.string(),
      version: z.string(),
      maxZoom: z.number(),
      /** [minLng, minLat, maxLng, maxLat] covered by the archive. */
      bounds: bbox,
    })
    .nullable(),
  /** Base for the style's glyphs (`/fonts/{fontstack}/{range}.pbf`) and sprites (`/sprites/v4/<theme>`). */
  assetsBaseUrl: z.string(),
  /** `map_label_language`: 'en' until the Bengali shaping spike passes (ADR 043). */
  labelLanguage: z.enum(['bn', 'en']),
  /**
   * `map_style_fallback`, null when disabled. An emergency replacement style:
   * if it is a Barikoi style, every map load costs 4 Barikoi API calls.
   */
  fallbackStyleUrl: z.string().nullable(),
  /** `map_kinds`: the Map tab's toggles, in order (ADR 046). */
  kinds: z.array(
    z.object({
      code: z.string(),
      /** An icon key the app maps to its own icon (hospital, pharmacy, food, gas, bank, bus, shop, listing). */
      icon: z.string(),
      label: z.object({ bn: z.string(), en: z.string() }),
    }),
  ),
  /** The clients' timings and limits, from settings (nothing hardcoded in an app). */
  client: z.object({
    /** geo_picker_idle_debounce_ms: LocationPicker waits this long after the map stops. */
    pickerIdleDebounceMs: z.number(),
    /** geo_autocomplete_debounce_ms */
    autocompleteDebounceMs: z.number(),
    /** geocode_autocomplete_min_chars: shorter queries are not sent. */
    autocompleteMinChars: z.number(),
    /** map_search_area_move_ratio: share of the viewport moved before "Search this area" shows. */
    searchAreaMoveRatio: z.number(),
    /** map_pin_label_min_zoom / map_pin_label_max: Bengali name images on the nearest pins. */
    pinLabelMinZoom: z.number(),
    pinLabelMax: z.number(),
  }),
});
export type MapConfig = z.infer<typeof mapConfigSchema>;
export class MapConfigDto extends createZodDto(mapConfigSchema) {}

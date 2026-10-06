import type { ExpressionSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import dark from '../styles/dark.json' with { type: 'json' };
import labels from '../styles/labels.json' with { type: 'json' };
import light from '../styles/light.json' with { type: 'json' };
import { ASSETS_PLACEHOLDER, LABEL_METADATA_KEY, TILES_PLACEHOLDER } from './constants';

export * from './constants';

/**
 * The Amar Elaka base map styles (ADR 043), shared by web and admin; the
 * Flutter app bundles the same JSON (apps/mobile/assets/map) and mirrors
 * resolveStyle() in lib/core/map/map_style.dart. Generated from the Protomaps
 * basemap theme by scripts/generate.ts — never hand-edit styles/*.json.
 */

export type MapTheme = 'light' | 'dark';
/** `map_label_language`: what map text is written in. */
export type MapLabelLanguage = 'bn' | 'en';

const TEMPLATES: Record<MapTheme, StyleSpecification> = {
  light: light as StyleSpecification,
  dark: dark as StyleSpecification,
};

/** The text-field for every name label in `lang` (styles/labels.json). */
export function labelText(lang: MapLabelLanguage): ExpressionSpecification {
  return (labels as Record<MapLabelLanguage, ExpressionSpecification>)[lang];
}

/**
 * Re-labels every name layer (tagged with LABEL_METADATA_KEY):
 *   bn — name:bn, else name (in Bangladesh, OSM's `name` is Bengali);
 *   en — name:en, else name only if the renderer can shape its script, else
 *        no label. Bengali is then never drawn as unshaped map text.
 */
export function withLabelLanguage(
  style: StyleSpecification,
  lang: MapLabelLanguage,
): StyleSpecification {
  const text = labelText(lang);
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const metadata = layer.metadata as Record<string, unknown> | undefined;
      if (layer.type !== 'symbol' || metadata?.[LABEL_METADATA_KEY] !== true) return layer;
      return { ...layer, layout: { ...layer.layout, 'text-field': text } };
    }),
  };
}

export interface ResolveStyleOptions {
  /** GET /map/config `tiles.url`: the versioned .pmtiles archive. */
  tilesUrl: string;
  /** GET /map/config `assetsBaseUrl`: fonts/ and sprites/ live under it. */
  assetsBaseUrl: string;
  lang: MapLabelLanguage;
}

/** A ready-to-load style: archive and asset URLs filled in, labels in `lang`. */
export function resolveStyle(theme: MapTheme, options: ResolveStyleOptions): StyleSpecification {
  const json = JSON.stringify(TEMPLATES[theme])
    .replaceAll(TILES_PLACEHOLDER, options.tilesUrl)
    .replaceAll(ASSETS_PLACEHOLDER, options.assetsBaseUrl.replace(/\/+$/, ''));
  return withLabelLanguage(JSON.parse(json) as StyleSpecification, options.lang);
}

/** The unresolved template, for validation and tooling. */
export function styleTemplate(theme: MapTheme): StyleSpecification {
  return TEMPLATES[theme];
}

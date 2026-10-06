/**
 * Generates styles/light.json, styles/dark.json and styles/labels.json from
 * the Protomaps basemap theme (@protomaps/basemaps), simplified for Amar
 * Elaka (ADR 043), and copies them into the Flutter app's assets.
 *
 *   pnpm --filter @amar-elaka/map-style generate
 *
 * What changes from the Protomaps theme:
 *   - POIs: only transport (stations, ferry terminals, bus stops, airports)
 *     stay, for orientation; shops, food, schools… are our own pins' job.
 *     House-number labels go too.
 *   - Roads: higher contrast — darker casings, so lanes read against blocks.
 *   - Neighbourhood names: darker, larger, not uppercased, a solid halo, so
 *     "Shyamoli" / "শ্যামলী" reads at neighbourhood zoom (13–15).
 *   - Labels: one rule for every name label (see labels.json), switched by
 *     the label language; tagged with metadata so road shields keep their ref.
 *   - Fonts: Noto Sans Regular / Medium only (self-hosted glyph PBFs); Italic →
 *     Regular. One font per stack: static glyph files can't combine stacks
 *     (that takes a glyph server). Bengali comes from Noto Sans Bengali font
 *     files through `font-faces`, so conjuncts are shaped (see FONT_FACES).
 *
 * The output holds placeholders — pmtiles://__TILES__ and __ASSETS__ — that
 * resolveStyle() (src/index.ts, and the Dart mirror) fills from GET /map/config.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { DARK, LIGHT, layers, type Flavor } from '@protomaps/basemaps';
import {
  ASSETS_PLACEHOLDER,
  LABEL_METADATA_KEY,
  MAP_ATTRIBUTION_HTML,
  MAP_SOURCE_ID,
  TILES_PLACEHOLDER,
} from '../src/constants';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'styles');
const MOBILE_ASSETS = join(here, '..', '..', '..', 'apps', 'mobile', 'assets', 'map');

const NAME: ExpressionSpecification = ['coalesce', ['get', 'name'], ''];
const FIRST_CHAR: ExpressionSpecification = ['slice', NAME, 0, 1];

/**
 * Every name label, by language.
 *
 *   bn — name:bn, else name (in Bangladesh, OSM's `name` is Bengali).
 *   en — name:en, else name unless it is written in Bengali (its first
 *        character is in U+0980–U+09FF), else no label: in `en`, Bengali is
 *        never map text. Not `is-supported-script`: MapLibre GL JS 6 no longer
 *        wires it up, so it always says true.
 */
const LABELS: Record<'bn' | 'en', ExpressionSpecification> = {
  bn: ['coalesce', ['get', 'name:bn'], ['get', 'name']],
  en: [
    'case',
    ['has', 'name:en'],
    ['get', 'name:en'],
    ['all', ['>=', FIRST_CHAR, '\u0980'], ['<=', FIRST_CHAR, '\u09ff']],
    '',
    NAME,
  ],
};

/**
 * Bengali drawn from real font files, not from the codepoint-keyed glyph PBFs:
 * the renderer shapes conjuncts and vowel signs with them (MapLibre GL JS 6,
 * Android SDK 11.13+, iOS 6.18+). Everything else still comes from `glyphs`.
 * Danda (U+0964–5) and ZWNJ/ZWJ belong to Bengali text too.
 */
const BENGALI_RANGES = ['U+0980-09FF', 'U+0964-0965', 'U+200C-200D'];
const FONT_FACES = {
  'Noto Sans Regular': [
    {
      url: `${ASSETS_PLACEHOLDER}/fonts/bengali/NotoSansBengali-Regular.ttf`,
      'unicode-range': BENGALI_RANGES,
    },
  ],
  'Noto Sans Medium': [
    {
      url: `${ASSETS_PLACEHOLDER}/fonts/bengali/NotoSansBengali-Medium.ttf`,
      'unicode-range': BENGALI_RANGES,
    },
  ],
};

const TRANSPORT_POIS = ['aerodrome', 'station', 'ferry_terminal', 'bus_stop'];
const DROPPED_LAYERS = new Set(['address_label']);
/** Symbol layers whose text is a name (not a road shield's ref). */
const NAME_LABEL_LAYERS = new Set([
  'water_waterway_label',
  'roads_labels_minor',
  'water_label_ocean',
  'earth_label_islands',
  'water_label_lakes',
  'roads_labels_major',
  'pois',
  'places_subplace',
  'places_region',
  'places_locality',
  'places_country',
]);

type Theme = 'light' | 'dark';

const THEMES: Record<Theme, { flavor: Flavor; subplace: string; halo: string }> = {
  light: {
    flavor: {
      ...LIGHT,
      minor_casing: '#d9d4cc',
      minor_service_casing: '#e0dbd3',
      major_casing_early: '#d9cbb0',
      major_casing_late: '#d9cbb0',
      highway_casing_early: '#d8b894',
      highway_casing_late: '#d8b894',
    },
    subplace: '#5f5f5f',
    halo: '#ffffff',
  },
  dark: {
    flavor: {
      ...DARK,
      minor_casing: '#1f1f1f',
      major_casing_early: '#1a1a1a',
      major_casing_late: '#1a1a1a',
      highway_casing_early: '#141414',
      highway_casing_late: '#141414',
    },
    subplace: '#bdbdbd',
    halo: '#1f1f1f',
  },
};

function replaceItalic(value: unknown): unknown {
  if (value === 'Noto Sans Italic') return 'Noto Sans Regular';
  if (Array.isArray(value)) return value.map(replaceItalic);
  return value;
}

function simplify(layer: LayerSpecification, theme: Theme): LayerSpecification | null {
  if (DROPPED_LAYERS.has(layer.id)) return null;
  if (layer.type !== 'symbol') return layer;

  const layout = { ...layer.layout } as Record<string, unknown>;
  const paint = { ...layer.paint } as Record<string, unknown>;
  const out: SymbolLayerSpecification = { ...layer };

  if (layout['text-font']) layout['text-font'] = replaceItalic(layout['text-font']);

  if (NAME_LABEL_LAYERS.has(layer.id)) {
    layout['text-field'] = LABELS.en;
    out.metadata = { [LABEL_METADATA_KEY]: true };
  }

  if (layer.id === 'pois') {
    out.filter = [
      'all',
      ['in', ['get', 'kind'], ['literal', TRANSPORT_POIS]],
      ['>=', ['zoom'], ['get', 'min_zoom']],
    ];
  }

  if (layer.id === 'places_subplace') {
    delete layout['text-transform'];
    layout['text-letter-spacing'] = 0;
    layout['text-size'] = ['interpolate', ['exponential', 1.2], ['zoom'], 11, 11, 14, 15, 18, 22];
    paint['text-color'] = THEMES[theme].subplace;
    paint['text-halo-color'] = THEMES[theme].halo;
    paint['text-halo-width'] = 1.5;
  }

  if (layer.id === 'roads_labels_minor') {
    // Lane names from z14 (the archive's deepest zoom), not z15.
    out.minzoom = 14;
  }

  return { ...out, layout, paint };
}

function style(theme: Theme): StyleSpecification {
  const all = layers(MAP_SOURCE_ID, THEMES[theme].flavor, { lang: 'en' });
  return {
    version: 8,
    name: `Amar Elaka ${theme}`,
    metadata: {
      'amar-elaka:generated-by': 'packages/map-style/scripts/generate.ts',
      'amar-elaka:theme': theme,
    },
    glyphs: `${ASSETS_PLACEHOLDER}/fonts/{fontstack}/{range}.pbf`,
    'font-faces': FONT_FACES,
    sprite: `${ASSETS_PLACEHOLDER}/sprites/v4/${theme}`,
    sources: {
      [MAP_SOURCE_ID]: {
        type: 'vector',
        url: `pmtiles://${TILES_PLACEHOLDER}`,
        attribution: MAP_ATTRIBUTION_HTML,
      },
    },
    layers: all
      .map((layer) => simplify(layer, theme))
      .filter((layer): layer is LayerSpecification => layer !== null),
  };
}

function write(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

for (const dir of [OUT, MOBILE_ASSETS]) {
  write(dir, 'light.json', style('light'));
  write(dir, 'dark.json', style('dark'));
  write(dir, 'labels.json', LABELS);
}
console.log(`wrote light.json, dark.json, labels.json to ${OUT} and ${MOBILE_ASSETS}`);

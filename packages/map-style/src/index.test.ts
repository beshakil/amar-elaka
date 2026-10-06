import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expression,
  validateStyleMin,
  type StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import {
  LABEL_METADATA_KEY,
  MAP_SOURCE_ID,
  labelText,
  resolveStyle,
  styleTemplate,
  type MapLabelLanguage,
  type MapTheme,
} from './index';

const here = dirname(fileURLToPath(import.meta.url));
const THEMES: MapTheme[] = ['light', 'dark'];
const LANGS: MapLabelLanguage[] = ['bn', 'en'];
const SELF_HOSTED_FONTS = new Set(['Noto Sans Regular', 'Noto Sans Medium']);

const resolved = (theme: MapTheme, lang: MapLabelLanguage) =>
  resolveStyle(theme, {
    tilesUrl: 'https://tiles.amarelaka.com/tiles/bd-20261005.pmtiles',
    assetsBaseUrl: 'https://tiles.amarelaka.com/tiles/',
    lang,
  });

/** Every font name a style can ask for, from literals and font expressions alike. */
function fontsIn(style: StyleSpecification): Set<string> {
  const fonts = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('Noto')) fonts.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const layer of style.layers) {
    if (layer.type === 'symbol') {
      collect(layer.layout?.['text-font']);
      collect(layer.layout?.['text-field']);
    }
  }
  return fonts;
}

describe.each(THEMES)('%s style', (theme) => {
  it('validates against the MapLibre style spec (template and both label languages)', () => {
    expect(validateStyleMin(styleTemplate(theme))).toEqual([]);
    for (const lang of LANGS) expect(validateStyleMin(resolved(theme, lang))).toEqual([]);
  });

  it('reads the versioned archive through pmtiles://, glyphs and sprites next to it', () => {
    const style = resolved(theme, 'en');
    expect(style.sources[MAP_SOURCE_ID]).toMatchObject({
      type: 'vector',
      url: 'pmtiles://https://tiles.amarelaka.com/tiles/bd-20261005.pmtiles',
    });
    expect(style.glyphs).toBe('https://tiles.amarelaka.com/tiles/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe(`https://tiles.amarelaka.com/tiles/sprites/v4/${theme}`);
  });

  it('carries the OpenStreetMap and Protomaps attribution', () => {
    const source = styleTemplate(theme).sources[MAP_SOURCE_ID] as { attribution?: string };
    expect(source.attribution).toContain('© <a href="https://www.openstreetmap.org/copyright"');
    expect(source.attribution).toContain('OpenStreetMap contributors');
    expect(source.attribution).toContain('Protomaps');
  });

  it('asks only for the self-hosted fonts', () => {
    expect([...fontsIn(styleTemplate(theme))].filter((f) => !SELF_HOSTED_FONTS.has(f))).toEqual([]);
  });

  it('never points at a third-party tile or style server', () => {
    const json = JSON.stringify(styleTemplate(theme));
    expect(json).not.toMatch(
      /openstreetmap\.org\/\{z\}|tile\.openstreetmap|barikoi|api\.protomaps/i,
    );
  });

  it('keeps only transport POIs and drops house numbers (our pins carry the POIs)', () => {
    const layers = styleTemplate(theme).layers;
    expect(layers.find((l) => l.id === 'address_label')).toBeUndefined();
    const pois = layers.find((l) => l.id === 'pois');
    expect(JSON.stringify(pois && 'filter' in pois ? pois.filter : null)).toContain('"station"');
    expect(JSON.stringify(pois && 'filter' in pois ? pois.filter : null)).not.toContain(
      'restaurant',
    );
  });

  it.each(LANGS)('writes every name label in %s, leaving road shields alone', (lang) => {
    const style = resolved(theme, lang);
    const named = style.layers.filter(
      (l) => (l.metadata as Record<string, unknown> | undefined)?.[LABEL_METADATA_KEY] === true,
    );
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const layer of named) {
      expect(layer.type === 'symbol' && layer.layout?.['text-field']).toEqual(labelText(lang));
    }
    const shields = style.layers.find((l) => l.id === 'roads_shields');
    expect(shields?.type === 'symbol' && shields.layout?.['text-field']).toEqual([
      'get',
      'shield_text',
    ]);
  });
});

describe('label language', () => {
  /** Evaluates a language's label rule the way the renderer does, for one feature. */
  const label = (lang: MapLabelLanguage, properties: Record<string, string>): unknown => {
    const parsed = expression.createExpression(labelText(lang), 'text-field', {
      type: 'string',
      'property-type': 'data-driven',
      transition: false,
      expression: { interpolated: false, parameters: ['zoom', 'feature'] },
    });
    if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
    return parsed.value.evaluate({ zoom: 14 }, { type: 'Point', properties } as never);
  };

  it('bn: name:bn, else name (OSM names in Bangladesh are already Bengali)', () => {
    expect(label('bn', { name: 'ধানমন্ডি', 'name:en': 'Dhanmondi' })).toBe('ধানমন্ডি');
    expect(label('bn', { name: 'Dhanmondi', 'name:bn': 'ধানমন্ডি' })).toBe('ধানমন্ডি');
    expect(label('bn', { name: 'Bashundhara City' })).toBe('Bashundhara City');
  });

  it('en: name:en, else a non-Bengali name, else nothing — never Bengali map text', () => {
    expect(label('en', { name: 'ধানমন্ডি', 'name:en': 'Dhanmondi' })).toBe('Dhanmondi');
    expect(label('en', { name: 'Bashundhara City' })).toBe('Bashundhara City');
    expect(label('en', { name: 'শ্যামলী' })).toBe('');
    expect(label('en', { name: 'ক্রিসেন্ট লেক' })).toBe('');
    expect(label('en', {})).toBe('');
  });
});

describe('Bengali font files (font-faces)', () => {
  it.each(THEMES)(
    '%s: both font stacks shape Bengali from self-hosted Noto Sans Bengali',
    (theme) => {
      const faces = resolved(theme, 'bn')['font-faces'] as Record<
        string,
        { url: string; 'unicode-range': string[] }[]
      >;
      for (const [stack, weight] of [
        ['Noto Sans Regular', 'Regular'],
        ['Noto Sans Medium', 'Medium'],
      ] as const) {
        expect(faces[stack]).toEqual([
          {
            url: `https://tiles.amarelaka.com/tiles/fonts/bengali/NotoSansBengali-${weight}.ttf`,
            'unicode-range': expect.arrayContaining(['U+0980-09FF']) as unknown,
          },
        ]);
      }
    },
  );
});

describe('the Flutter app bundles the same generated files', () => {
  it.each(['light.json', 'dark.json', 'labels.json'])('%s is identical', (file) => {
    const pkg = readFileSync(join(here, '..', 'styles', file), 'utf8');
    const mobile = readFileSync(
      join(here, '..', '..', '..', 'apps', 'mobile', 'assets', 'map', file),
      'utf8',
    );
    expect(mobile).toBe(pkg);
  });
});

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PinoLogger } from 'nestjs-pino';
import type { SettingsService } from '../settings/settings.service';
import { MapConfigService } from './map-config.service';

const manifest = (version: string) => ({
  version,
  file: `bd-${version}.pmtiles`,
  maxZoom: 14,
  bbox: [87.95, 20.55, 92.75, 26.75],
  bytes: 199_000_000,
  sha256: 'abc',
  source: `https://build.protomaps.com/${version}.pmtiles`,
  builtAt: '2026-10-05T00:00:00Z',
});

describe('MapConfigService', () => {
  let root: string;
  const values: Record<string, unknown> = {
    map_label_language: 'bn',
    map_style_fallback: 'https://maps.example/style.json',
    map_kinds: [
      {
        code: 'bank',
        icon: 'bank',
        label_bn: 'ব্যাংক ও এটিএম',
        label_en: 'Banks & ATMs',
        sources: [{ table: 'places', categories: ['bank-atm'] }],
      },
    ],
    geo_picker_idle_debounce_ms: 600,
    geo_autocomplete_debounce_ms: 400,
    geocode_autocomplete_min_chars: 3,
    map_search_area_move_ratio: 0.3,
    map_pin_label_min_zoom: 17,
    map_pin_label_max: 40,
  };
  const settings = {
    get: jest.fn((key: string) => Promise.resolve(values[key])),
  } as unknown as SettingsService;
  const shared = {
    kinds: [{ code: 'bank', icon: 'bank', label: { bn: 'ব্যাংক ও এটিএম', en: 'Banks & ATMs' } }],
    client: {
      pickerIdleDebounceMs: 600,
      autocompleteDebounceMs: 400,
      autocompleteMinChars: 3,
      searchAreaMoveRatio: 0.3,
      pinLabelMinZoom: 17,
      pinLabelMax: 40,
    },
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = (publicUrl?: string) =>
    new MapConfigService(
      { MAP_TILES_PATH: root, MAP_TILES_PUBLIC_URL: publicUrl, API_PUBLIC_URL: 'http://api.test/' },
      settings,
      logger as unknown as PinoLogger,
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'map-config-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('has no tiles before the first build, without failing', async () => {
    await expect(service().config()).resolves.toEqual({
      tiles: null,
      assetsBaseUrl: 'http://api.test/tiles',
      labelLanguage: 'bn',
      fallbackStyleUrl: 'https://maps.example/style.json',
      ...shared,
    });
  });

  it('points at the versioned archive and picks up a new build', async () => {
    const path = join(root, 'current.json');
    writeFileSync(path, JSON.stringify(manifest('20261005')));
    const svc = service('https://tiles.example/tiles');
    expect((await svc.config()).tiles).toEqual({
      url: 'https://tiles.example/tiles/bd-20261005.pmtiles',
      version: '20261005',
      maxZoom: 14,
      bounds: [87.95, 20.55, 92.75, 26.75],
    });

    writeFileSync(path, JSON.stringify(manifest('20261105')));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect((await svc.config()).tiles?.version).toBe('20261105');
  });

  it('treats a malformed manifest as no tiles (and logs it)', async () => {
    writeFileSync(join(root, 'current.json'), JSON.stringify({ file: '../../etc/passwd' }));
    expect((await service().config()).tiles).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});

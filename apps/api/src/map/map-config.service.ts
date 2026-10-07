import { stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { SettingsService } from '../settings/settings.service';
import { tilesManifestSchema, type MapConfig, type TilesManifest } from './map-config.dto';
import { MAP_TILES_ROUTE } from './map-tiles.routes';

export const TILES_MANIFEST_FILE = 'current.json';

/**
 * What a client needs to draw the base map (ADR 043): the live versioned
 * archive (from current.json, re-read whenever build-tiles.sh replaces it),
 * where fonts and sprites live, and the label language setting. There is no
 * third-party fallback style: without our tiles the map says it is
 * unavailable (map_style_fallback was retired in 0049). The style itself
 * ships with each client (packages/map-style).
 */
@Injectable()
export class MapConfigService {
  private readonly root: string;
  private readonly publicBase: string | null;
  private cached: { mtimeMs: number; manifest: TilesManifest | null } | null = null;

  constructor(
    @Inject(APP_CONFIG)
    env: Pick<Env, 'MAP_TILES_PATH' | 'MAP_TILES_PUBLIC_URL' | 'API_PUBLIC_URL'>,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MapConfigService.name);
    this.root = resolve(env.MAP_TILES_PATH);
    this.publicBase =
      env.MAP_TILES_PUBLIC_URL ??
      (env.API_PUBLIC_URL ? `${env.API_PUBLIC_URL.replace(/\/+$/, '')}${MAP_TILES_ROUTE}` : null);
  }

  async config(): Promise<MapConfig> {
    const [
      manifest,
      labelLanguage,
      kinds,
      idleDebounce,
      autocompleteDebounce,
      minChars,
      moveRatio,
      labelZoom,
      labelMax,
    ] = await Promise.all([
      this.manifest(),
      this.settings.get('map_label_language'),
      this.settings.get('map_kinds'),
      this.settings.get('geo_picker_idle_debounce_ms'),
      this.settings.get('geo_autocomplete_debounce_ms'),
      this.settings.get('geocode_autocomplete_min_chars'),
      this.settings.get('map_search_area_move_ratio'),
      this.settings.get('map_pin_label_min_zoom'),
      this.settings.get('map_pin_label_max'),
    ]);
    const base = this.publicBase ?? MAP_TILES_ROUTE;
    return {
      tiles:
        manifest === null
          ? null
          : {
              url: `${base}/${manifest.file}`,
              version: manifest.version,
              maxZoom: manifest.maxZoom,
              bounds: manifest.bbox,
            },
      assetsBaseUrl: base,
      labelLanguage,
      kinds: kinds.map((k) => ({
        code: k.code,
        icon: k.icon,
        label: { bn: k.label_bn, en: k.label_en },
      })),
      client: {
        pickerIdleDebounceMs: idleDebounce,
        autocompleteDebounceMs: autocompleteDebounce,
        autocompleteMinChars: minChars,
        searchAreaMoveRatio: moveRatio,
        pinLabelMinZoom: labelZoom,
        pinLabelMax: labelMax,
      },
    };
  }

  /** The tiles directory on disk (MAP_TILES_PATH). */
  get tilesRoot(): string {
    return this.root;
  }

  /** The public URL of a file under the tiles directory. */
  tilesUrl(path: string): string {
    return `${this.publicBase ?? MAP_TILES_ROUTE}/${path}`;
  }

  /** current.json, cached until its mtime changes; null (logged) when missing or malformed. */
  async manifest(): Promise<TilesManifest | null> {
    const path = join(this.root, TILES_MANIFEST_FILE);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      if (this.cached?.mtimeMs !== -1) {
        this.logger.warn({ path }, 'no base map built yet (run scripts/map/build-tiles.sh)');
      }
      this.cached = { mtimeMs: -1, manifest: null };
      return null;
    }
    if (this.cached?.mtimeMs === mtimeMs) return this.cached.manifest;

    let manifest: TilesManifest | null = null;
    try {
      const parsed = tilesManifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) manifest = parsed.data;
      else this.logger.error({ path, issues: parsed.error.issues }, 'malformed tiles manifest');
    } catch (error) {
      this.logger.error({ path, err: error }, 'unreadable tiles manifest');
    }
    this.cached = { mtimeMs, manifest };
    return manifest;
  }
}

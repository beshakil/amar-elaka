import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { TenantRequiredException } from '../../database/tenant.exceptions';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import { MapConfigService } from '../map-config.service';
import { sha256Of } from './offline-map.builder';
import type { OfflineAreas, OfflineMapManifest } from './offline-map.dto';
import { OfflineMapRepository } from './offline-map.repository';

// settings-exempt: metres per degree of latitude (WGS84 mean), a unit conversion
const METERS_PER_DEGREE = 111_320;
const SPRITES_DIR = 'sprites/v4';
const BENGALI_FONTS_DIR = 'fonts/bengali';

type AssetFile = OfflineMapManifest['assets'][number];

/**
 * What the app downloads for "এলাকার ম্যাপ ডাউনলোড" (ADR 050): the tenant's
 * newest ready archive, plus the glyph ranges (offline_map_glyph_ranges of
 * every font stack), Bengali font files and sprites the style needs — each
 * with its size and sha256 so the app can resume and verify. Checksums of the
 * shared assets are computed once per file version (mtime + size).
 */
@Injectable()
export class OfflineMapService {
  private readonly checksums = new Map<string, string>();

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: OfflineMapRepository,
    private readonly mapConfig: MapConfigService,
    private readonly settings: SettingsService,
  ) {}

  async manifest(): Promise<OfflineMapManifest> {
    const tenantId = this.requireTenant();
    const [national, latest, ranges, pointSets, labelLanguage, updateCheckHours] =
      await Promise.all([
        this.mapConfig.manifest(),
        this.tenantDb.transaction((tx) => this.repo.latestReady(tx), { accessMode: 'read only' }),
        this.settings.get('offline_map_glyph_ranges'),
        this.settings.get('offline_map_point_sets'),
        this.settings.get('map_label_language'),
        this.settings.get('offline_map_update_check_hours'),
      ]);
    const attempt = national
      ? await this.tenantDb.transaction(
          (tx) => this.repo.forVersion(tx, tenantId, national.version),
          {
            accessMode: 'read only',
          },
        )
      : undefined;
    const reason: OfflineMapManifest['reason'] =
      latest !== undefined
        ? null
        : attempt?.status_code === 'too_large'
          ? 'too_large'
          : attempt?.status_code === 'failed'
            ? 'failed'
            : 'not_built';

    const archive =
      latest &&
      latest.file_name &&
      latest.bytes !== null &&
      latest.sha256 &&
      latest.max_zoom !== null
        ? {
            path: latest.file_name,
            url: this.mapConfig.tilesUrl(latest.file_name),
            bytes: latest.bytes,
            sha256: latest.sha256,
            version: latest.national_version,
            maxZoom: latest.max_zoom,
            bounds: [latest.min_lng!, latest.min_lat!, latest.max_lng!, latest.max_lat!] as [
              number,
              number,
              number,
              number,
            ],
            builtAt: latest.built_at.toISOString(),
          }
        : null;
    const assets = archive ? await this.assets(ranges) : [];
    const assetsBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
    return {
      available: archive !== null,
      reason,
      archive,
      assets,
      assetsBytes,
      totalBytes: assetsBytes + (archive?.bytes ?? 0),
      pointSets: pointSets.map((p) => ({ layers: p.layers, kinds: p.kinds ?? null })),
      labelLanguage,
      updateCheckHours,
    };
  }

  async areas(): Promise<OfflineAreas> {
    this.requireTenant();
    const toleranceM = await this.settings.get('offline_map_area_simplify_m');
    const features = await this.tenantDb.transaction(
      (tx) => this.repo.areas(tx, toleranceM / METERS_PER_DEGREE),
      { accessMode: 'read only' },
    );
    return { type: 'FeatureCollection', features };
  }

  /** Glyph ranges of every font stack, the Bengali font files and the sprites, as they are on disk. */
  private async assets(ranges: readonly string[]): Promise<AssetFile[]> {
    const root = this.mapConfig.tilesRoot;
    const paths: string[] = [];
    const stacks = await readdir(join(root, 'fonts'), { withFileTypes: true }).catch(() => []);
    for (const stack of stacks) {
      if (!stack.isDirectory() || stack.name === 'bengali') continue;
      for (const range of ranges) paths.push(`fonts/${stack.name}/${range}.pbf`);
    }
    for (const dir of [BENGALI_FONTS_DIR, SPRITES_DIR]) {
      const files = await readdir(join(root, dir)).catch(() => [] as string[]);
      for (const name of files.sort()) {
        if (/\.(ttf|json|png)$/.test(name)) paths.push(`${dir}/${name}`);
      }
    }
    const files: AssetFile[] = [];
    for (const path of paths.sort()) {
      const info = await stat(join(root, path)).catch(() => null);
      if (!info?.isFile()) continue;
      const key = `${path}:${info.mtimeMs}:${info.size}`;
      let sha256 = this.checksums.get(key);
      if (!sha256) {
        sha256 = await sha256Of(join(root, path));
        this.checksums.set(key, sha256);
      }
      files.push({
        path,
        url: this.mapConfig.tilesUrl(encodePath(path)),
        bytes: info.size,
        sha256,
      });
    }
    return files;
  }

  private requireTenant(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

/** "Noto Sans Regular" → "Noto%20Sans%20Regular", segment by segment. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

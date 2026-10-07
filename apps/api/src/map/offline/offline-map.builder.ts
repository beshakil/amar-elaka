import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { JobBudget, JobOutcome } from '../../jobs/job-batches';
import { SettingsService } from '../../settings/settings.service';
import type { TilesManifest } from '../map-config.dto';
import { MapConfigService } from '../map-config.service';
import { OfflineMapRepository, type OfflineFileResult } from './offline-map.repository';
import { PMTILES_EXTRACTOR, PmtilesExtractError, type PmtilesExtractor } from './pmtiles-cli';

/** Under the tiles root: tenants/<tenant id>-<national version>.pmtiles. */
export const TENANTS_DIR = 'tenants';
// settings-exempt: the previous version stays one cycle (a phone mid-download keeps reading it), as for the national file
const KEEP_READY_VERSIONS = 2;
// settings-exempt: unit conversion
const BYTES_PER_MB = 1024 * 1024;

export function offlineFileName(tenantId: string, version: string): string {
  return `${TENANTS_DIR}/${tenantId}-${version.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.pmtiles`;
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * The worker's side of offline maps (ADR 050). For each live tenant without a
 * file cut from the CURRENT national archive (current.json), `pmtiles extract`
 * its boundary + offline_map_buffer_km up to offline_map_max_zoom; a file over
 * offline_map_max_mb is cut again one zoom shallower, down to
 * offline_map_min_zoom, then given up as too_large. The new file is written
 * beside the old (a dotted temp name the static route never serves, then a
 * rename), its sha256 recorded, and versions older than the previous one are
 * deleted. A refreshed national archive is a new version: every tenant is cut
 * again on the next run. Failures are recorded per tenant and retried.
 */
@Injectable()
export class OfflineMapBuilder {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: OfflineMapRepository,
    private readonly mapConfig: MapConfigService,
    private readonly settings: SettingsService,
    @Inject(PMTILES_EXTRACTOR) private readonly extractor: PmtilesExtractor,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OfflineMapBuilder.name);
  }

  async run(budget: JobBudget): Promise<JobOutcome> {
    const national = await this.mapConfig.manifest();
    if (!national) return { rows: 0, capped: false };
    const tenants = await this.asSystem((tx) => this.repo.liveTenants(tx));
    const limit = budget.batchSize * budget.maxBatches;
    let built = 0;
    for (const tenant of tenants) {
      const existing = await this.asSystem((tx) =>
        this.repo.forVersion(tx, tenant.id, national.version),
      );
      // A failure is tried again; a finished build (ready, or too big at every zoom) is not.
      if (existing && existing.status_code !== 'failed') continue;
      if (built >= limit) return { rows: built, capped: true };
      await this.buildTenant(tenant.id, national);
      built++;
    }
    return { rows: built, capped: false };
  }

  /** Cuts one tenant's file from `national` and records the result. */
  async buildTenant(tenantId: string, national: TilesManifest): Promise<OfflineFileResult> {
    const root = this.mapConfig.tilesRoot;
    const fileName = offlineFileName(tenantId, national.version);
    const temp = join(root, TENANTS_DIR, `.${tenantId}-${Date.now()}.tmp.pmtiles`);
    const base: OfflineFileResult = {
      tenantId,
      nationalVersion: national.version,
      status: 'failed',
      fileName: null,
      bytes: null,
      sha256: null,
      maxZoom: null,
      bounds: null,
      error: null,
    };
    let result: OfflineFileResult;
    try {
      const [maxMb, maxZoomSetting, minZoom, bufferKm] = await Promise.all([
        this.settings.get('offline_map_max_mb', tenantId),
        this.settings.get('offline_map_max_zoom', tenantId),
        this.settings.get('offline_map_min_zoom'),
        this.settings.get('offline_map_buffer_km', tenantId),
      ]);
      const bounds = await this.asSystem((tx) => this.repo.tenantBounds(tx, tenantId, bufferKm));
      if (!bounds) throw new Error('the tenant has no area or map centre');
      await mkdir(join(root, TENANTS_DIR), { recursive: true });
      const cap = maxMb * BYTES_PER_MB;
      const input = join(root, national.file);

      let fitted: { zoom: number; bytes: number } | null = null;
      let lastBytes: number | null = null;
      const start = Math.min(maxZoomSetting, national.maxZoom);
      // Never below offline_map_min_zoom — unless the national archive itself stops above it.
      const floor = Math.min(minZoom, start);
      for (let zoom = start; zoom >= floor; zoom--) {
        await this.extractor.extract(input, temp, bounds, zoom);
        lastBytes = (await stat(temp)).size;
        if (lastBytes <= cap) {
          fitted = { zoom, bytes: lastBytes };
          break;
        }
      }
      if (!fitted) {
        result = {
          ...base,
          status: 'too_large',
          bytes: lastBytes,
          bounds,
          error: `over offline_map_max_mb (${maxMb} MB) at every zoom down to ${floor}`,
        };
      } else {
        const sha256 = await sha256Of(temp);
        await rename(temp, join(root, fileName));
        result = {
          ...base,
          status: 'ready',
          fileName,
          bytes: fitted.bytes,
          sha256,
          maxZoom: fitted.zoom,
          bounds,
        };
      }
    } catch (error) {
      // Only a short reason in the table (it is readable by anyone in the tenant); the detail goes to the log.
      this.logger.error(
        { err: error, tenantId, version: national.version },
        'offline map build failed',
      );
      result = {
        ...base,
        error: error instanceof PmtilesExtractError ? 'pmtiles extract failed' : 'build failed',
      };
    } finally {
      await rm(temp, { force: true });
    }
    await this.asSystem((tx) => this.repo.save(tx, result));
    if (result.status === 'ready') {
      const stale = await this.asSystem((tx) =>
        this.repo.pruneReady(tx, tenantId, KEEP_READY_VERSIONS),
      );
      for (const file of stale) {
        if (file !== result.fileName) await rm(join(root, file), { force: true });
      }
    }
    return result;
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

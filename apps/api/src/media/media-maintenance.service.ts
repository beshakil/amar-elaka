import { Inject, Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { mediaAssets } from '../database/schema/content';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { MEDIA_KIND_POLICIES } from '../storage/media-kind.constants';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { assetObjectKeys } from './media.types';

// settings-exempt: work-batch size for a background sweep (throughput tuning), not a business rule
const SWEEP_BATCH = 200;
// settings-exempt: see above — caps one run so a huge backlog can't hold the worker forever
const SWEEP_MAX_BATCHES = 50;

const AssetKeys = z.object({
  id: z.string(),
  kind_code: z.enum(['image', 'video', 'document']),
  storage_key: z.string(),
  variants: z.unknown(),
});
type AssetKeysRow = z.infer<typeof AssetKeys>;

/**
 * The two cross-tenant media sweeps (run as `system` by media.processor.ts):
 *
 *   - Orphans: uploads older than `orphan_media_hours` that nothing uses — never
 *     confirmed, rejected, or ready but never attached to a post, store, message,
 *     ad, avatar or logo (media_asset_is_referenced, 0019). The row is deleted
 *     first (the RESTRICTIVE policy re-checks "unreferenced" at that instant, so
 *     a post attaching it concurrently wins), then its objects.
 *   - Purge: soft-deleted media whose `purge_due_at` has passed (set when a post
 *     is deleted, 0019). Objects are deleted and `purged_at` set; the row stays
 *     so references don't dangle (schema.md §4.1).
 * Both skip evidence holds and legal holds.
 */
@Injectable()
export class MediaMaintenanceService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MediaMaintenanceService.name);
  }

  async cleanOrphans(): Promise<number> {
    const hours = await this.settings.get('orphan_media_hours');
    let removed = 0;
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const rows = await this.asSystem((tx) =>
        tx.execute(sql`
          delete from public.media_assets m
          where m.id in (
            select c.id from public.media_assets c
            where c.deleted_at is null
              and not c.evidence_hold
              and c.created_at < now() - make_interval(hours => ${hours})
              and not public.media_asset_is_referenced(c.id, c.storage_key)
              and not public.legal_hold_blocks('media_asset', c.id)
            order by c.created_at
            limit ${SWEEP_BATCH}
            for update skip locked
          )
          returning m.id, m.kind_code, m.storage_key, m.variants`),
      );
      const parsed = z.array(AssetKeys).parse([...rows]);
      await this.deleteObjects(parsed);
      removed += parsed.length;
      if (parsed.length < SWEEP_BATCH) break;
    }
    if (removed > 0) this.logger.info({ removed }, 'removed orphan media');
    return removed;
  }

  async purgeDeleted(): Promise<number> {
    let purged = 0;
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      // Claim a batch, delete its objects, then mark it purged. If object
      // deletion fails the batch stays unpurged and the next run retries it.
      const claimed = await this.asSystem(async (tx) => {
        const rows = await tx.execute(sql`
          select m.id, m.kind_code, m.storage_key, m.variants
          from public.media_assets m
          where m.purge_due_at is not null
            and m.purge_due_at <= now()
            and m.purged_at is null
            and not m.evidence_hold
            and not public.legal_hold_blocks('media_asset', m.id)
          order by m.purge_due_at
          limit ${SWEEP_BATCH}`);
        return z.array(AssetKeys).parse([...rows]);
      });
      if (claimed.length === 0) break;

      await this.deleteObjects(claimed);
      await this.asSystem((tx) =>
        tx
          .update(mediaAssets)
          .set({ purgedAt: sql`now()` })
          .where(
            inArray(
              mediaAssets.id,
              claimed.map((row) => row.id),
            ),
          ),
      );
      purged += claimed.length;
      if (claimed.length < SWEEP_BATCH) break;
    }
    if (purged > 0) this.logger.info({ purged }, 'purged deleted media');
    return purged;
  }

  private async deleteObjects(rows: AssetKeysRow[]): Promise<void> {
    for (const bucket of ['media', 'documents'] as const) {
      const keys = rows
        .filter((row) => MEDIA_KIND_POLICIES[row.kind_code].bucket === bucket)
        .flatMap((row) => assetObjectKeys(row.storage_key, row.variants));
      if (keys.length > 0) await this.storage.deleteMany(bucket, keys);
    }
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantContext.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

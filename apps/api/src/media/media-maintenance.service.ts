import { Inject, Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { mediaAssets } from '../database/schema/content';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { inBatches, type JobBudget, type JobOutcome } from '../jobs/job-batches';
import { SettingsService } from '../settings/settings.service';
import { MEDIA_KIND_POLICIES } from '../storage/media-kind.constants';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { assetObjectKeys } from './media.types';

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
 *     ad, avatar or logo (media_asset_is_referenced, 0019). Row and objects go in
 *     one transaction: the rows are deleted (the RESTRICTIVE policy re-checks
 *     "unreferenced" at that instant, and the row locks make a concurrent
 *     attach wait, then fail), the objects deleted, then commit. If the objects
 *     can't be deleted the transaction rolls back and the rows stay for the
 *     next run — never a row gone with its files left behind.
 *   - Purge: soft-deleted media whose `purge_due_at` has passed (set when a post
 *     is deleted, 0019). Objects are deleted and `purged_at` set; the row stays
 *     so references don't dangle (schema.md §4.1).
 * Both skip evidence holds and legal holds, work in batches within the
 * JobRunner's budget (ADR 031), and are idempotent: a deleted or purged asset
 * is never selected again, and deleting an object already gone succeeds.
 */
@Injectable()
export class MediaMaintenanceService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
  ) {}

  async cleanOrphans(budget: JobBudget): Promise<JobOutcome> {
    const hours = await this.settings.get('orphan_media_hours');
    return inBatches(budget, (limit) =>
      this.asSystem(async (tx) => {
        // A locking CTE runs exactly once; `id in (select … limit)` may not.
        const rows = await tx.execute(sql`
          with due as (
            select c.id from public.media_assets c
            where c.deleted_at is null
              and not c.evidence_hold
              and c.created_at < now() - make_interval(hours => ${hours})
              and not public.media_asset_is_referenced(c.id, c.storage_key)
              and not public.legal_hold_blocks('media_asset', c.id)
            order by c.created_at
            limit ${limit}
            for update skip locked
          )
          delete from public.media_assets m using due where m.id = due.id
          returning m.id, m.kind_code, m.storage_key, m.variants`);
        const removed = z.array(AssetKeys).parse([...rows]);
        await this.deleteObjects(removed);
        return removed.length;
      }),
    );
  }

  async purgeDeleted(budget: JobBudget): Promise<JobOutcome> {
    return inBatches(budget, async (limit) => {
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
          limit ${limit}`);
        return z.array(AssetKeys).parse([...rows]);
      });
      if (claimed.length === 0) return 0;

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
      return claimed.length;
    });
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

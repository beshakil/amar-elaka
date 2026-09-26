import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { inBatches, type JobBudget, type JobOutcome } from '../jobs/job-batches';
import { SettingsService } from '../settings/settings.service';

/**
 * Deletes drafts nobody touched for `draft_retention_days` (ADR 031). A draft
 * was never published, so it has no history to keep: a hard delete, the only
 * one posts allow (RESTRICTIVE policy, 0028: system, draft, no legal hold).
 *
 *  - Legal holds (on the post or its author) are skipped here and refused
 *    again by the policy.
 *  - A draft something still points at (a report, a saved post, a lead…)
 *    is left alone rather than failing the batch on a RESTRICT foreign key.
 *  - Its media attachments go with it (CASCADE); the photos are then orphans
 *    and the orphan-media job removes them, files included.
 *
 * Idempotent: a deleted draft can't be selected again.
 */
@Injectable()
export class DraftCleanupService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly settings: SettingsService,
  ) {}

  async cleanStale(budget: JobBudget): Promise<JobOutcome> {
    const days = await this.settings.get('draft_retention_days');
    return inBatches(budget, (limit) =>
      this.context.run({ role: 'system' }, () =>
        this.tenantDb.transaction(async (tx) => {
          // A CTE, not `id in (select … limit)`: the planner may re-run that
          // subquery and exceed the limit; a locking CTE runs exactly once.
          const rows = await tx.execute(sql`
            with due as (
              select d.id from public.posts d
              where d.status_code = 'draft'
                and d.updated_at < now() - make_interval(days => ${days})
                and d.deletion_reason_code is distinct from 'legal_hold'
                and not public.legal_hold_blocks('post', d.id)
                and not exists (select 1 from public.saved_posts x where x.post_id = d.id)
                and not exists (select 1 from public.reports x where x.post_id = d.id)
                and not exists (select 1 from public.moderation_actions x where x.post_id = d.id)
                and not exists (select 1 from public.boosts x where x.post_id = d.id)
                and not exists (select 1 from public.credit_transactions x where x.post_id = d.id)
                and not exists (select 1 from public.lead_events x where x.post_id = d.id)
                and not exists (select 1 from public.lead_daily_stats x where x.post_id = d.id)
              order by d.updated_at
              limit ${limit}
              for update skip locked
            )
            delete from public.posts p using due where p.id = due.id
            returning p.id`);
          return z.array(z.object({ id: z.string() })).parse([...rows]).length;
        }),
      ),
    );
  }
}

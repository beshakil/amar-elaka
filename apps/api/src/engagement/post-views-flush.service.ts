import { Inject, Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { ENGAGEMENT_STORE, type EngagementStore } from './engagement.store';
import { EngagementRepository } from './engagement.repository';

/**
 * The flush-post-views job (ADR 036): moves the pending Redis view counts
 * aside and adds them to posts.view_count through add_post_views (0031),
 * job_batch_size posts per transaction. Each flushed chunk is taken off the
 * batch right after its commit, so a crash re-sends at most the one chunk in
 * flight (at-least-once), and a batch left behind is picked up first next run.
 */
@Injectable()
export class PostViewsFlushService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: EngagementRepository,
    @Inject(ENGAGEMENT_STORE) private readonly store: EngagementStore,
  ) {}

  flush(budget: JobBudget): Promise<JobOutcome> {
    return this.context.run({ role: 'system' }, async () => {
      let rows = 0;
      let batches = 0;
      for (;;) {
        const pending = await this.store.takePendingViews();
        if (!pending) return { rows, capped: false };
        const entries = [...pending.counts];
        for (let start = 0; start < entries.length; start += budget.batchSize) {
          if (batches >= budget.maxBatches) return { rows, capped: true };
          const chunk = entries.slice(start, start + budget.batchSize);
          rows += await this.tenantDb.transaction((tx) => this.repo.addViews(tx, chunk));
          await this.store.ackPendingViews(
            pending.batchKey,
            chunk.map(([postId]) => postId),
          );
          batches++;
        }
      }
    });
  }
}

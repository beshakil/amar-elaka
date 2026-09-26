import { Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { inBatches, type JobBudget, type JobOutcome } from '../jobs/job-batches';
import { assertTransition } from './post-state-machine';
import { PostsRepository } from './posts.repository';

/**
 * live → expired for posts past `expires_at` (the listing period the
 * category set when the post went live). Runs in the worker as `system`,
 * across tenants, one locked batch per transaction, each expiry with its
 * post.expired outbox event in the same transaction. Idempotent: only posts
 * still `live` and past due are selected, so a second run finds nothing.
 */
@Injectable()
export class PostExpiryService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PostsRepository,
  ) {}

  expireDue(budget: JobBudget): Promise<JobOutcome> {
    assertTransition('live', 'expired', 'system');
    return inBatches(budget, (limit) =>
      this.context.run({ role: 'system' }, () =>
        this.tenantDb.transaction(async (tx) => {
          const due = await this.repo.expireDue(tx, limit);
          for (const post of due) {
            await this.repo.emit(tx, 'post.expired', post.id, {
              tenantId: post.tenantId,
              from: 'live',
              to: 'expired',
            });
          }
          return due.length;
        }),
      ),
    );
  }
}

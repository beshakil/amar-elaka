import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { assertTransition } from './post-state-machine';
import { PostsRepository } from './posts.repository';

// settings-exempt: work-batch size for a background sweep (throughput tuning), not a business rule
const EXPIRY_BATCH = 500;
// settings-exempt: caps one run so a huge backlog can't hold the worker forever
const EXPIRY_MAX_BATCHES = 20;

/**
 * live → expired for posts past `expires_at` (the listing period the
 * category set when the post went live). Runs in the worker as `system`,
 * across tenants, one locked batch per transaction, each expiry with its
 * post.expired outbox event in the same transaction.
 */
@Injectable()
export class PostExpiryService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PostsRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PostExpiryService.name);
  }

  async expireDue(): Promise<number> {
    assertTransition('live', 'expired', 'system');
    let expired = 0;
    for (let batch = 0; batch < EXPIRY_MAX_BATCHES; batch++) {
      const rows = await this.context.run({ role: 'system' }, () =>
        this.tenantDb.transaction(async (tx) => {
          const due = await this.repo.expireDue(tx, EXPIRY_BATCH);
          for (const post of due) {
            await this.repo.emit(tx, 'post.expired', post.id, {
              tenantId: post.tenantId,
              from: 'live',
              to: 'expired',
            });
          }
          return due;
        }),
      );
      expired += rows.length;
      if (rows.length < EXPIRY_BATCH) break;
    }
    if (expired > 0) this.logger.info({ expired }, 'expired posts');
    return expired;
  }
}

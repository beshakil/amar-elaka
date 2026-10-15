import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { NotificationService } from '../notifications/notification.service';
import { SettingsService } from '../settings/settings.service';
import { ReviewsRepository } from './reviews.repository';

/**
 * "কেমন লাগল?" (ADR 061): review_prompt_hours after a member contacts a
 * store, they are asked once — ever — to review it. due_review_prompts
 * claims the due contacts (once per member and store, never the store's own
 * people, never a store they already reviewed, never a stale backlog);
 * each becomes a notification through NotificationService, so preferences,
 * quiet hours and the daily caps apply as to everything else. The deep link
 * opens the review form.
 */
@Injectable()
export class ReviewPromptsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: ReviewsRepository,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReviewPromptsService.name);
  }

  async run(budget: JobBudget): Promise<JobOutcome> {
    const limit = Math.min(
      budget.batchSize * budget.maxBatches,
      await this.settings.get('review_prompt_batch_size'),
    );
    const due = await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx) => this.repo.duePrompts(tx, limit)),
    );
    let sent = 0;
    for (const prompt of due) {
      try {
        await this.notifications.send({
          userId: prompt.user_id,
          type: 'review_prompt',
          tenantId: prompt.tenant_id,
          params: { storeId: prompt.store_id, storeName: prompt.store_name },
          deepLink: `/stores/${prompt.store_id}/review`,
          entityId: prompt.store_id,
          dedupeKey: `review_prompt:${prompt.store_id}:${prompt.user_id}`,
        });
        sent += 1;
      } catch (error) {
        // Claimed already (once ever): a lost prompt is better than a repeated one.
        this.logger.warn({ err: error, storeId: prompt.store_id }, 'review prompt not queued');
      }
    }
    return { rows: sent, capped: due.length === limit, details: { due: due.length } };
  }
}

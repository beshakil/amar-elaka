import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { JobBudget, JobOutcome } from '../../jobs/job-batches';
import { NotificationService } from '../../notifications/notification.service';
import { SettingsService } from '../../settings/settings.service';
import { SavedSearchesRepository } from '../saved-searches.repository';
import { dhakaTime, notificationDue } from './notification-policy';

/**
 * Tells users about new matches (ADR 041): ONE notification per saved search
 * however many posts matched since the last one ("7 new results for
 * 'flat in Mirpur'"), sent through NotificationService, so every registered
 * channel delivers it — in-app now, push/SMS/email when they plug in
 * (notifications/notification-channel.ts). When to send is
 * notification-policy.ts (frequency, daily digest hour, per-day cap).
 *
 * A match is marked notified only once a channel delivered it; a failed
 * delivery is retried on the next run, with anything newer grouped in.
 */
@Injectable()
export class SavedSearchNotifierService {
  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SavedSearchNotifierService.name);
  }

  async notifyPending(budget: JobBudget, now = new Date()): Promise<JobOutcome> {
    const [perDay, digestHour] = await Promise.all([
      this.settings.get('saved_search_notify_per_day'),
      this.settings.get('saved_search_daily_digest_hour'),
    ]);
    const limit = budget.batchSize * budget.maxBatches;
    const pending = await this.asSystem((tx) => this.repo.withPendingMatches(tx, limit));
    const today = dhakaTime(now).day;
    let sent = 0;
    let held = 0;
    for (const search of pending) {
      if (!notificationDue(search, now, { perDay, digestHour })) {
        held += 1;
        continue;
      }
      const { delivered } = await this.notifications.send({
        userId: search.user_id,
        type: 'saved_search_match',
        params: { savedSearchId: search.id, name: search.name, count: String(search.pending) },
        deepLink: `/saved-searches/${search.id}`,
        entityId: search.id,
        // A retry of the same group can't notify twice.
        dedupeKey: `saved_search_match:${search.id}:${search.max_match_id}`,
      });
      if (delivered === 0) continue;
      await this.asSystem((tx) =>
        this.repo.markNotified(tx, search.id, search.max_match_id, today),
      );
      sent += 1;
    }
    return { rows: sent, capped: pending.length === limit, details: { held } };
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

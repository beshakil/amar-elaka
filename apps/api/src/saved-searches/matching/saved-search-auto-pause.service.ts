import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { inBatches, type JobBudget, type JobOutcome } from '../../jobs/job-batches';
import { NotificationService } from '../../notifications/notification.service';
import { SettingsService } from '../../settings/settings.service';
import { SavedSearchesRepository } from '../saved-searches.repository';

/**
 * Pauses saved searches nobody has opened for saved_search_auto_pause_days
 * (0 = never) and tells the owner in a final notice, `saved_search_paused`:
 * no more alerts until they resume it (PATCH active: true). "Opened" is
 * creating, changing or opening its new results (last_engaged_at).
 */
@Injectable()
export class SavedSearchAutoPauseService {
  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
  ) {}

  async pauseIdle(budget: JobBudget): Promise<JobOutcome> {
    const days = await this.settings.get('saved_search_auto_pause_days');
    if (days === 0) return { rows: 0, capped: false };
    return inBatches(budget, async (limit) => {
      const paused = await this.asSystem((tx) => this.repo.pauseIdle(tx, days, limit));
      for (const search of paused) {
        // After the pause committed: the notice never announces a pause that rolled back.
        await this.notifications.send({
          userId: search.user_id,
          type: 'saved_search_paused',
          params: { savedSearchId: search.id, name: search.name, idleDays: String(days) },
          deepLink: `/saved-searches/${search.id}`,
          entityId: search.id,
          dedupeKey: `saved_search_paused:${search.id}:${new Date().toISOString().slice(0, 'yyyy-mm-dd'.length)}`,
        });
      }
      return paused.length;
    });
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

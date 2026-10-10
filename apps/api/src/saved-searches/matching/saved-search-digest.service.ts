import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { SCHEDULE_TIMEZONE } from '../../common/schedule-timezone';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { JobBudget, JobOutcome } from '../../jobs/job-batches';
import { NotificationService } from '../../notifications/notification.service';
import { SettingsService } from '../../settings/settings.service';
import { dhakaTime } from './notification-policy';

const DUE_USER = z.object({ user_id: z.string(), searches: z.number(), total: z.number() });

/** ISO weekday (1 = Monday … 7 = Sunday) of `at` in Asia/Dhaka. */
export function dhakaWeekday(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIMEZONE,
    weekday: 'short',
  }).format(at);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1;
}

/** Due on the configured weekday, from the configured hour (Asia/Dhaka). */
export function digestDue(now: Date, weekday: number, hour: number): boolean {
  return dhakaWeekday(now) === weekday && dhakaTime(now).hour >= hour;
}

/**
 * The weekly saved-search digest (ADR 059): once a week, every user whose
 * saved searches found anything in the past week gets one summary — how
 * many searches, how many new results — in-app and by email (the type's
 * channels; the user's preferences apply). Searches with alerts off don't
 * count. Instant and daily alerts are unchanged (SavedSearchNotifierService).
 *
 * Runs hourly; does anything only on saved_search_weekly_digest_weekday from
 * saved_search_weekly_digest_hour. The dedupe key is that day, and users who
 * already have it are skipped, so a run that missed the hour (worker down)
 * still sends, and a second run sends nothing twice.
 */
@Injectable()
export class SavedSearchDigestService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
  ) {}

  async sendWeekly(budget: JobBudget, now = new Date()): Promise<JobOutcome> {
    const [weekday, hour] = await Promise.all([
      this.settings.get('saved_search_weekly_digest_weekday'),
      this.settings.get('saved_search_weekly_digest_hour'),
    ]);
    if (!digestDue(now, weekday, hour)) return { rows: 0, capped: false, details: { due: 0 } };
    const dedupeKey = `saved_search_weekly_digest:${dhakaTime(now).day}`;
    const limit = budget.batchSize * budget.maxBatches;
    const users = await this.asSystem((tx) => this.dueUsers(tx, dedupeKey, now, limit));
    for (const user of users) {
      await this.notifications.send({
        userId: user.user_id,
        type: 'saved_search_weekly_digest',
        params: { searches: String(user.searches), total: String(user.total) },
        deepLink: '/saved-searches',
        entityId: null,
        dedupeKey,
      });
    }
    return { rows: users.length, capped: users.length === limit, details: { due: 1 } };
  }

  private async dueUsers(
    tx: DatabaseTransaction,
    dedupeKey: string,
    now: Date,
    limit: number,
  ): Promise<z.infer<typeof DUE_USER>[]> {
    const rows = await tx.execute(sql`
      select ss.user_id, count(distinct ss.id)::int as searches, count(*)::int as total
      from public.saved_search_matches m
      join public.saved_searches ss on ss.id = m.saved_search_id
      where m.created_at >= ${now.toISOString()}::timestamptz - interval '7 days'
        and ss.deleted_at is null and ss.is_active and ss.alert_frequency_code <> 'off'
        and not exists (
          select 1 from public.notifications n where n.user_id = ss.user_id and n.dedupe_key = ${dedupeKey})
      group by ss.user_id
      order by ss.user_id
      limit ${limit}`);
    return z.array(DUE_USER).parse([...rows]);
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { JobBudget, JobOutcome } from '../../jobs/job-batches';
import { SettingsService } from '../../settings/settings.service';
import { addDays, ANALYTICS_TIMEZONE, localDay } from './analytics-day';
import {
  ANALYTICS_COUNTER_STORE,
  type AnalyticsCounterStore,
  type EntityRef,
} from './analytics-counter.store';
import {
  contactField,
  COUNTER_FIELDS,
  LEAD_CHANNEL_TO_CONTACT,
  type DayMetrics,
} from './analytics-metrics';
import {
  SellerAnalyticsRepository,
  type DailyUpsert,
  type LeadDayRow,
} from './seller-analytics.repository';

const entityKey = (e: EntityRef) => `${e.tenantId}|${e.type}|${e.id}`;

/** The lead rows' contacts per entity: counts by channel and the sum of distinct people. */
function leadContacts(
  rows: readonly LeadDayRow[],
): Map<string, { entity: EntityRef; metrics: DayMetrics; people: number }> {
  const out = new Map<string, { entity: EntityRef; metrics: DayMetrics; people: number }>();
  for (const row of rows) {
    const channel = LEAD_CHANNEL_TO_CONTACT[row.channel_code];
    const entity: EntityRef | null = row.post_id
      ? { tenantId: row.tenant_id, type: 'post', id: row.post_id }
      : row.store_id
        ? { tenantId: row.tenant_id, type: 'store', id: row.store_id }
        : null;
    if (!channel || !entity) continue;
    const key = entityKey(entity);
    const current = out.get(key) ?? { entity, metrics: {}, people: 0 };
    const field = contactField(channel);
    current.metrics[field] = (current.metrics[field] ?? 0) + row.event_count;
    current.people += row.unique_actor_count;
    out.set(key, current);
  }
  return out;
}

/**
 * The rollup-analytics job (ADR 055), nightly after local midnight: each of
 * the last analytics_rollup_days_back finished days becomes analytics_daily
 * rows — views, saves, shares, search appearances and map taps from the day's
 * Redis counters, the distinct viewers/contacters from its sketches, and the
 * contacts from lead_events (scrub-aware, the one authoritative count; also
 * written to lead_daily_stats). Idempotent: a re-run replaces a day's rows
 * with the same numbers, so revisiting a few days fills a missed night.
 */
@Injectable()
export class AnalyticsRollupService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: SellerAnalyticsRepository,
    @Inject(ANALYTICS_COUNTER_STORE) private readonly store: AnalyticsCounterStore,
    private readonly settings: SettingsService,
  ) {}

  rollup(budget: JobBudget, now: Date = new Date()): Promise<JobOutcome> {
    return this.context.run({ role: 'system' }, async () => {
      const back = await this.settings.get('analytics_rollup_days_back');
      const today = localDay(now);
      let rows = 0;
      let batches = 0;
      // Oldest first: a capped run leaves the newest days for the next one.
      for (let k = back; k >= 1; k--) {
        if (batches >= budget.maxBatches) return { rows, capped: true };
        const day = addDays(today, -k);
        const leads = leadContacts(
          await this.tenantDb.transaction((tx) =>
            this.repo.rollupLeads(tx, day, ANALYTICS_TIMEZONE),
          ),
        );
        batches++;
        const entities = new Map<string, EntityRef>();
        for (const entity of await this.store.touched(day)) entities.set(entityKey(entity), entity);
        for (const { entity } of leads.values()) entities.set(entityKey(entity), entity);

        const all = [...entities.values()];
        for (let start = 0; start < all.length; start += budget.batchSize) {
          if (batches >= budget.maxBatches) return { rows, capped: true };
          const chunk = all.slice(start, start + budget.batchSize);
          const counters = await this.store.readDay(day, chunk);
          const upserts: DailyUpsert[] = [];
          for (const [i, entity] of chunk.entries()) {
            const metrics = await this.dayMetrics(
              day,
              entity,
              counters[i] ?? {},
              leads.get(entityKey(entity)),
            );
            if (Object.keys(metrics).length === 0) continue;
            upserts.push({
              tenantId: entity.tenantId,
              entityType: entity.type,
              entityId: entity.id,
              day,
              metrics,
            });
          }
          rows += await this.tenantDb.transaction((tx) => this.repo.upsertDaily(tx, upserts));
          batches++;
        }
      }
      return { rows, capped: false };
    });
  }

  private async dayMetrics(
    day: string,
    entity: EntityRef,
    counters: DayMetrics,
    leads: { metrics: DayMetrics; people: number } | undefined,
  ): Promise<DayMetrics> {
    const metrics: DayMetrics = {};
    // Everything but contacts from the counters; contacts only from lead_events.
    for (const field of COUNTER_FIELDS) {
      if (field.startsWith('contacts_')) continue;
      if (counters[field]) metrics[field] = counters[field];
    }
    Object.assign(metrics, leads?.metrics ?? {});
    const owner = [{ type: entity.type, id: entity.id }];
    const [viewers, contacters] = await Promise.all([
      this.store.countUnique('viewers', [day], owner),
      this.store.countUnique('contacters', [day], owner),
    ]);
    if (viewers > 0) metrics.unique_viewers = viewers;
    const people = contacters > 0 ? contacters : (leads?.people ?? 0);
    if (people > 0) metrics.unique_contacters = people;
    return metrics;
  }
}

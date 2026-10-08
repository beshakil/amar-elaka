import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../database/database.client';
import type { EntityType } from './analytics-counter.store';
import type { DayMetrics } from './analytics-metrics';

const LEAD_ROW = z.object({
  tenant_id: z.string(),
  post_id: z.string().nullable(),
  store_id: z.string().nullable(),
  place_id: z.string().nullable(),
  channel_code: z.string(),
  event_count: z.number(),
  unique_actor_count: z.number(),
  subject_scrubbed: z.boolean(),
});
export type LeadDayRow = z.infer<typeof LEAD_ROW>;

const SCOPE_ROW = z.object({
  post_id: z.string(),
  tenant_id: z.string(),
  store_id: z.string().nullable(),
  author_member_id: z.string().nullable(),
  title: z.string(),
  status_code: z.string(),
  created_at: z.coerce.date(),
});
export type ScopePostRow = z.infer<typeof SCOPE_ROW>;

const DAILY_ROW = z.object({
  entity_type: z.enum(['post', 'store']),
  entity_id: z.string(),
  stat_date: z.string(),
  metrics: z.record(z.unknown()),
});
export type DailyRow = z.infer<typeof DAILY_ROW>;

export interface DailyUpsert {
  tenantId: string;
  entityType: EntityType;
  entityId: string;
  day: string;
  metrics: DayMetrics;
}

/** Seller analytics in Postgres (0051): the nightly rollup's writes and the dashboard's reads. */
@Injectable()
export class SellerAnalyticsRepository {
  // ---- the nightly rollup (system role) ------------------------------------------

  /** One local day of lead_events into lead_daily_stats; what it wrote. The only lead_events read. */
  async rollupLeads(tx: DatabaseTransaction, day: string, timeZone: string): Promise<LeadDayRow[]> {
    const rows = await tx.execute(sql`
      select tenant_id, post_id, store_id, place_id, channel_code, event_count, unique_actor_count,
             subject_scrubbed
      from public.analytics_rollup_leads(${day}::date, ${timeZone})`);
    return z.array(LEAD_ROW).parse([...rows]);
  }

  /**
   * Replaces each entity-day's metrics (idempotent: a re-run writes the same).
   * A post scrubbed since is written flagged, so it never shows.
   */
  async upsertDaily(tx: DatabaseTransaction, rows: readonly DailyUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map(
      (r) =>
        sql`(${r.tenantId}::uuid, ${r.entityType}, ${r.entityId}::uuid, ${r.day}::date, ${JSON.stringify(r.metrics)}::jsonb)`,
    );
    const result = await tx.execute(sql`
      insert into public.analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics, subject_scrubbed)
      select v.tenant_id, v.entity_type, v.entity_id, v.stat_date, v.metrics,
             v.entity_type = 'post' and exists (
               select 1 from public.posts p
               where p.tenant_id = v.tenant_id and p.id = v.entity_id and p.scrubbed_at is not null)
      from (values ${sql.join(values, sql`, `)}) as v (tenant_id, entity_type, entity_id, stat_date, metrics)
      on conflict (tenant_id, entity_type, entity_id, stat_date)
      do update set metrics = excluded.metrics,
                    subject_scrubbed = analytics_daily.subject_scrubbed or excluded.subject_scrubbed
      returning id`);
    return result.length;
  }

  // ---- the dashboard (the caller's own context) -------------------------------------

  /** seller_scope_posts (0051): the store's posts for its owner and managers, or the caller's own posts. */
  async scope(tx: DatabaseTransaction, storeId: string | null): Promise<ScopePostRow[]> {
    const rows = await tx.execute(sql`
      select post_id, tenant_id, store_id, author_member_id, title, status_code, created_at
      from public.seller_scope_posts(${storeId}::uuid)`);
    return z.array(SCOPE_ROW).parse([...rows]);
  }

  async daily(
    tx: DatabaseTransaction,
    storeId: string | null,
    from: string,
    to: string,
  ): Promise<DailyRow[]> {
    const rows = await tx.execute(sql`
      select entity_type, entity_id, stat_date::text as stat_date, metrics
      from public.seller_daily_metrics(${storeId}::uuid, ${from}::date, ${to}::date)`);
    return z.array(DAILY_ROW).parse([...rows]);
  }

  /** The searches that led to clicks on the scope's posts, from local day `from` up to (not including) `toExclusive`. */
  async topQueries(
    tx: DatabaseTransaction,
    storeId: string | null,
    window: { from: string; toExclusive: string; timeZone: string },
    minSearchers: number,
    limit: number,
  ): Promise<{ q_normalized: string; searchers: number; clicks: number }[]> {
    const rows = await tx.execute(sql`
      select q_normalized, searchers::int as searchers, clicks::int as clicks
      from public.seller_top_queries(
        ${storeId}::uuid,
        (${window.from}::date)::timestamp at time zone ${window.timeZone},
        (${window.toExclusive}::date)::timestamp at time zone ${window.timeZone},
        ${minSearchers}::integer, ${limit}::integer)`);
    return z
      .array(z.object({ q_normalized: z.string(), searchers: z.number(), clicks: z.number() }))
      .parse([...rows]);
  }

  /** Which of these days already have a rolled-up row for any of the scope's entities. */
  async rolledUpDays(
    tx: DatabaseTransaction,
    storeId: string | null,
    days: readonly string[],
  ): Promise<Set<string>> {
    if (days.length === 0) return new Set();
    const rows = await this.daily(tx, storeId, days[0]!, days.at(-1)!);
    return new Set(rows.map((r) => r.stat_date));
  }
}

import { boolean, date, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id } from './columns';
import { tenants } from './tenancy';

// ---- analytics_daily (0051, ADR 055): TENANT-SCOPED ------------------------

/**
 * One row per post or store per local day: the seller dashboard's history.
 * Written by the nightly rollup (Redis counters + lead_events); today's
 * numbers come live from Redis. Read through the seller_* SECURITY DEFINER
 * functions, never scanned for a page from lead_events.
 */
export const analyticsDaily = pgTable('analytics_daily', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // 'post' | 'store' (CHECK); the entity id is not an FK: history outlives it.
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  statDate: date('stat_date').notNull(),
  // views, unique_viewers, contacts_<channel>, unique_contacters, saves,
  // share_opens, search_appearances, map_taps — whole numbers.
  metrics: jsonb('metrics').notNull().default({}),
  // The post was privacy-scrubbed: excluded everywhere (§13.31).
  subjectScrubbed: boolean('subject_scrubbed').notNull().default(false),
  ...auditColumns(),
});

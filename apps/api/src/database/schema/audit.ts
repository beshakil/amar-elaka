import { sql } from 'drizzle-orm';
import { inet, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, timestamptz } from './columns';

/**
 * §11.4 Immutable audit trail, range-partitioned monthly on occurred_at.
 * No FKs by design: the log must outlive anything it mentions.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id')
      .notNull()
      .default(sql`uuid_generate_v7()`),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    tenantId: uuid('tenant_id'),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    entityTable: text('entity_table').notNull(),
    entityId: uuid('entity_id'),
    changes: jsonb('changes').$type<Record<string, [unknown, unknown]>>(),
    reason: text('reason'),
    requestId: text('request_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.id, table.occurredAt] })],
);

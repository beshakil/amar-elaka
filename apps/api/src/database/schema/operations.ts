import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, geographyPoint, id, timestamptz } from './columns';
import {
  activityEventTypes,
  agentEmploymentTypes,
  agentStatuses,
  commissionSources,
  commissionStatuses,
  legalHoldSubjectTypes,
  remittanceMethods,
  remittanceStatuses,
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
  visitOutcomes,
  visitPurposes,
} from './enums';
import { users } from './identity';
import { tenants } from './tenancy';

/**
 * Operations domain (docs/specs/schema.md §11, migration 0012). audit_logs
 * itself lives in audit.ts (built in 0001/0002); this file covers the rest:
 * field agents and their visits/commissions/cash remittances, activity
 * logs, support tickets and their thread, the transactional outbox, and
 * legal holds.
 */

/** §11.1 A member working as a field agent for the tenant. */
export const fieldAgents = pgTable('field_agents', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, member_id) -> tenant_members, RESTRICT.
  memberId: uuid('member_id').notNull(),
  agentCode: text('agent_code').notNull(),
  employmentTypeCode: text('employment_type_code')
    .notNull()
    .references(() => agentEmploymentTypes.code, { onDelete: 'restrict' }),
  defaultCommissionPct: numeric('default_commission_pct', { precision: 5, scale: 2 }),
  primaryGeoAreaId: uuid('primary_geo_area_id'),
  cashLimit: numeric('cash_limit', { precision: 12, scale: 2 }).notNull().default('0'),
  statusCode: text('status_code')
    .notNull()
    .default('active')
    .references(() => agentStatuses.code, { onDelete: 'restrict' }),
  joinedOn: date('joined_on').notNull(),
  terminatedOn: date('terminated_on'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  deletedAt: timestamptz('deleted_at'),
});

/** §11.2 A geotagged field visit by an agent. */
export const agentVisits = pgTable('agent_visits', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, field_agent_id) -> field_agents, RESTRICT.
  fieldAgentId: uuid('field_agent_id').notNull(),
  // Composite FKs (tenant_id, *) -> places / stores, both SET NULL.
  placeId: uuid('place_id'),
  storeId: uuid('store_id'),
  purposeCode: text('purpose_code')
    .notNull()
    .references(() => visitPurposes.code, { onDelete: 'restrict' }),
  outcomeCode: text('outcome_code')
    .notNull()
    .references(() => visitOutcomes.code, { onDelete: 'restrict' }),
  visitedAt: timestamptz('visited_at').notNull(),
  checkInLocation: geographyPoint('check_in_location').notNull(),
  checkInAccuracyM: integer('check_in_accuracy_m'),
  distanceFromTargetM: integer('distance_from_target_m'),
  notes: text('notes'),
  clientVisitId: text('client_visit_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** §11.3 Commission accrued by an agent for a qualifying event. */
export const agentCommissions = pgTable('agent_commissions', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, field_agent_id) -> field_agents, RESTRICT.
  fieldAgentId: uuid('field_agent_id').notNull(),
  sourceCode: text('source_code')
    .notNull()
    .references(() => commissionSources.code, { onDelete: 'restrict' }),
  // Composite FKs (tenant_id, *) -> payments / stores / agent_visits, all
  // RESTRICT; reverses_commission_id is a composite self-reference.
  paymentId: uuid('payment_id'),
  storeId: uuid('store_id'),
  agentVisitId: uuid('agent_visit_id'),
  basisAmount: numeric('basis_amount', { precision: 12, scale: 2 }),
  ratePct: numeric('rate_pct', { precision: 5, scale: 2 }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  reversesCommissionId: uuid('reverses_commission_id'),
  statusCode: text('status_code')
    .notNull()
    .default('accrued')
    .references(() => commissionStatuses.code, { onDelete: 'restrict' }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  approvedAt: timestamptz('approved_at'),
  paidAt: timestamptz('paid_at'),
  paidReference: text('paid_reference'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/**
 * §11.5 Product-level user activity, for "recently viewed" and light
 * analytics. Partitioned monthly on occurred_at (PK must include it).
 */
export const activityLogs = pgTable(
  'activity_logs',
  {
    id: uuid('id')
      .notNull()
      .default(sql`uuid_generate_v7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    memberId: uuid('member_id'), // no FK (volume; survives member deletion)
    anonSessionHash: text('anon_session_hash'),
    eventTypeCode: text('event_type_code')
      .notNull()
      .references(() => activityEventTypes.code, { onDelete: 'restrict' }),
    entityTable: text('entity_table'),
    entityId: uuid('entity_id'), // no FK
    properties: jsonb('properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.id, table.occurredAt] })],
);

/** §11.6 A help request from a member to the tenant's support team. */
export const supportTickets = pgTable('support_tickets', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  ticketNumber: text('ticket_number').notNull(),
  // Composite FK (tenant_id, requester_member_id) -> tenant_members, RESTRICT.
  requesterMemberId: uuid('requester_member_id').notNull(),
  categoryCode: text('category_code')
    .notNull()
    .references(() => ticketCategories.code, { onDelete: 'restrict' }),
  subject: text('subject').notNull(),
  statusCode: text('status_code')
    .notNull()
    .default('open')
    .references(() => ticketStatuses.code, { onDelete: 'restrict' }),
  priorityCode: text('priority_code')
    .notNull()
    .default('normal')
    .references(() => ticketPriorities.code, { onDelete: 'restrict' }),
  assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  // Composite FKs (tenant_id, *) -> payments / posts / reports, all SET NULL.
  paymentId: uuid('payment_id'),
  postId: uuid('post_id'),
  reportId: uuid('report_id'),
  firstResponseDueAt: timestamptz('first_response_due_at'),
  firstRespondedAt: timestamptz('first_responded_at'),
  escalatedAt: timestamptz('escalated_at'),
  resolvedAt: timestamptz('resolved_at'),
  closedAt: timestamptz('closed_at'),
  satisfactionRating: smallint('satisfaction_rating'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** §11.7 A message in a support ticket thread, including internal notes. */
export const ticketMessages = pgTable('ticket_messages', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, support_ticket_id) -> support_tickets, RESTRICT.
  supportTicketId: uuid('support_ticket_id').notNull(),
  authorUserId: uuid('author_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  isInternalNote: boolean('is_internal_note').notNull().default(false),
  body: text('body').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** §11.8 Transactional outbox: relayed to BullMQ / Meilisearch. */
export const outboxEvents = pgTable('outbox_events', {
  id: id(),
  aggregateTable: text('aggregate_table').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
  availableAt: timestamptz('available_at').notNull().defaultNow(),
  attempts: smallint('attempts').notNull().default(0),
  processedAt: timestamptz('processed_at'),
  lastError: text('last_error'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/**
 * §11.9 Registry of legal holds: a subject whose content must be preserved
 * until a platform admin releases it.
 */
export const legalHolds = pgTable('legal_holds', {
  id: id(),
  subjectTypeCode: text('subject_type_code')
    .notNull()
    .references(() => legalHoldSubjectTypes.code, { onDelete: 'restrict' }),
  // Polymorphic by decision, no FK (§13.14 exception) — a trigger verifies
  // the subject exists at placement.
  subjectId: uuid('subject_id').notNull(),
  subjectTenantId: uuid('subject_tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  externalReference: text('external_reference'),
  placedByUserId: uuid('placed_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  placedAt: timestamptz('placed_at').notNull().defaultNow(),
  releasedByUserId: uuid('released_by_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  releasedAt: timestamptz('released_at'),
  releaseReason: text('release_reason'),
  scrubOnRelease: boolean('scrub_on_release').notNull().default(true),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** §11.10 An agent handing collected cash over to the partner. */
export const agentCashRemittances = pgTable('agent_cash_remittances', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, field_agent_id) -> field_agents, RESTRICT.
  fieldAgentId: uuid('field_agent_id').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  methodCode: text('method_code')
    .notNull()
    .references(() => remittanceMethods.code, { onDelete: 'restrict' }),
  externalReference: text('external_reference'),
  statusCode: text('status_code')
    .notNull()
    .default('submitted')
    .references(() => remittanceStatuses.code, { onDelete: 'restrict' }),
  submittedAt: timestamptz('submitted_at').notNull().defaultNow(),
  confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  confirmedAt: timestamptz('confirmed_at'),
  disputeNote: text('dispute_note'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

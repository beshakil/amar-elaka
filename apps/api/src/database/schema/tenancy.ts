import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz } from './columns';
import {
  banSeverities,
  counterTypes,
  creditValuationMethods,
  memberRoles,
  memberStatuses,
  moderationModes,
  tenantStatuses,
  tenantTransferStatuses,
} from './enums';
import { geoAreas } from './catalog';
import { users } from './identity';
import { partners } from './partners';
import { roles } from './rbac';

/** §2.3 One operating territory (one upazila / metro thana). */
export const tenants = pgTable('tenants', {
  id: id(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  geoAreaId: uuid('geo_area_id')
    .notNull()
    .references(() => geoAreas.id, { onDelete: 'restrict' }),
  slug: text('slug').notNull(),
  customDomain: text('custom_domain'),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  statusCode: text('status_code')
    .notNull()
    .default('provisioning')
    .references(() => tenantStatuses.code, { onDelete: 'restrict' }),
  defaultLocale: text('default_locale').notNull().default('bn'),
  timezone: text('timezone').notNull().default('Asia/Dhaka'),
  mapCenter: geographyPoint('map_center').notNull(),
  launchedAt: timestamptz('launched_at'),
  pastDueSince: timestamptz('past_due_since'),
  suspendedAt: timestamptz('suspended_at'),
  terminatedAt: timestamptz('terminated_at'),
  archivedAt: timestamptz('archived_at'),
  statusReason: text('status_reason'),
  ...auditColumns(),
});

/** §2.4 Tenant-editable configuration (1:1 with tenants). */
export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  contactPhoneE164: text('contact_phone_e164'),
  contactEmail: text('contact_email'),
  whatsappE164: text('whatsapp_e164'),
  aboutBn: text('about_bn'),
  aboutEn: text('about_en'),
  logoStorageKey: text('logo_storage_key'),
  postModerationModeCode: text('post_moderation_mode_code')
    .notNull()
    .default('post')
    .references(() => moderationModes.code, { onDelete: 'restrict' }),
  settingOverrides: jsonb('setting_overrides')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  featureFlags: jsonb('feature_flags')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  ...auditColumns(),
});

/** §2.11 A user's membership in one tenant: role, status and ban status. */
export const tenantMembers = pgTable('tenant_members', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  roleCode: text('role_code')
    .notNull()
    .default('member')
    .references(() => memberRoles.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('active')
    .references(() => memberStatuses.code, { onDelete: 'restrict' }),
  banSeverityCode: text('ban_severity_code').references(() => banSeverities.code, {
    onDelete: 'restrict',
  }),
  // Fine-grained permission override (apps/api/src/rbac) — NULL means "use
  // the built-in role matching roleCode". roleCode itself stays the RLS
  // baseline and is untouched by this.
  customRoleId: uuid('custom_role_id').references(() => roles.id, { onDelete: 'set null' }),
  // Composite FK (tenant_id, home_locality_id) -> localities (tenant_id, id)
  // ON DELETE SET NULL (home_locality_id) since 0004 — the PG15+ column-list
  // SET NULL form isn't expressible through drizzle's foreignKey() builder
  // (it applies one onDelete action to every column), so this stays a bare
  // column here; the real constraint lives only in the SQL migration.
  homeLocalityId: uuid('home_locality_id'),
  joinedAt: timestamptz('joined_at').notNull().defaultNow(),
  lastActiveAt: timestamptz('last_active_at'),
  ...softDeleteColumns(),
});

/** §2.5 A hostname that resolves to a tenant (subdomain or custom domain). */
export const tenantDomains = pgTable('tenant_domains', {
  id: id(),
  // Never cascade from a tenant (§13.30).
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  hostname: text('hostname').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  verifiedAt: timestamptz('verified_at'),
  ...auditColumns(),
});

/** §2.6 Gapless per-tenant sequences (invoice no., ticket no.). Composite natural key, no lifecycle of its own. */
export const tenantCounters = pgTable(
  'tenant_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    counterCode: text('counter_code')
      .notNull()
      .references(() => counterTypes.code, { onDelete: 'restrict' }),
    periodKey: text('period_key').notNull().default(''),
    lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.counterCode, table.periodKey] })],
);

/** §2.14 Append-only log of every tenant lifecycle transition. */
export const tenantStatusChanges = pgTable('tenant_status_changes', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  fromStatusCode: text('from_status_code').references(() => tenantStatuses.code, {
    onDelete: 'restrict',
  }),
  toStatusCode: text('to_status_code')
    .notNull()
    .references(() => tenantStatuses.code, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  isAutomatic: boolean('is_automatic').notNull(),
  bypassedGrace: boolean('bypassed_grace').notNull().default(false),
  ...auditColumns(),
});

/** §2.15 A tenant's billing state: what the partner owes and when (1:1). */
export const tenantBilling = pgTable('tenant_billing', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  billingContactUserId: uuid('billing_contact_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  billingEmail: text('billing_email'),
  amountDue: numeric('amount_due', { precision: 12, scale: 2 }).notNull().default('0'),
  nextDueAt: timestamptz('next_due_at'),
  oldestUnpaidDueAt: timestamptz('oldest_unpaid_due_at'),
  lastPaymentAt: timestamptz('last_payment_at'),
  ...auditColumns(),
});

/** §2.13 Handover of a tenant from a departing partner to an incoming one. */
export const tenantTransfers = pgTable('tenant_transfers', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  fromPartnerId: uuid('from_partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  toPartnerId: uuid('to_partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('draft')
    .references(() => tenantTransferStatuses.code, { onDelete: 'restrict' }),
  effectiveAt: timestamptz('effective_at'),
  outstandingCredits: bigint('outstanding_credits', { mode: 'number' }).notNull().default(0),
  creditValuationMethodCode: text('credit_valuation_method_code')
    .notNull()
    .default('original_purchase_price')
    .references(() => creditValuationMethods.code, { onDelete: 'restrict' }),
  creditLiabilityAmount: numeric('credit_liability_amount', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  valuationDetail: jsonb('valuation_detail')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  // Composite FK (tenant_id, final_settlement_id) -> settlements, RESTRICT (0008).
  finalSettlementId: uuid('final_settlement_id'),
  // Correlation id (settlement_ledger_entries.journal_id), not a row FK.
  liabilityJournalId: uuid('liability_journal_id'),
  agreementStorageKeys: text('agreement_storage_keys')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  cancelledReason: text('cancelled_reason'),
  notes: text('notes'),
  ...auditColumns(),
});

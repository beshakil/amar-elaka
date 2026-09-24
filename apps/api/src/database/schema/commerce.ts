import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { categories } from './catalog';
import { auditColumns, id, softDeleteColumns, timestamptz } from './columns';
import {
  adBookingStatuses,
  adCreativeStatuses,
  adSurfaces,
  billingIntervals,
  boostPlacements,
  boostStatuses,
  boostStopReasons,
  boostTargets,
  closureRefundStatuses,
  creditDispositionOutcomes,
  creditPoolStatuses,
  creditReasons,
  invoiceLineTypes,
  invoiceStatuses,
  liabilitySettlementKinds,
  moderationReasons,
  portDestinationRules,
  revenueStreams,
  subscriptionStatuses,
  subscriptionSubjects,
  taxInvoiceFormats,
} from './enums';
import { users } from './identity';
import { partners } from './partners';
import { payments, refunds } from './payments';
import { tenants } from './tenancy';

// ---- credit_closure_dispositions (§6.22): GLOBAL ---------------------------
// Created first in the migration because credit_transactions references it.

export const creditClosureDispositions = pgTable('credit_closure_dispositions', {
  id: id(),
  closedTenantId: uuid('closed_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  creditsTotal: integer('credits_total').notNull(),
  purchasedCredits: integer('purchased_credits').notNull(),
  purchasedValueBdt: numeric('purchased_value_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  outcomeCode: text('outcome_code')
    .notNull()
    .references(() => creditDispositionOutcomes.code, { onDelete: 'restrict' }),
  destinationTenantId: uuid('destination_tenant_id').references(() => tenants.id, {
    onDelete: 'restrict',
  }),
  destinationRuleCode: text('destination_rule_code').references(() => portDestinationRules.code, {
    onDelete: 'restrict',
  }),
  destinationDistanceKm: numeric('destination_distance_km', { precision: 8, scale: 2 }),
  refundDeadlineAt: timestamptz('refund_deadline_at').notNull(),
  refundStatusCode: text('refund_status_code')
    .notNull()
    .default('not_requested')
    .references(() => closureRefundStatuses.code, { onDelete: 'restrict' }),
  refundedCredits: integer('refunded_credits').notNull().default(0),
  refundedAmount: numeric('refunded_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  notifiedInAppAt: timestamptz('notified_in_app_at'),
  notifiedSmsAt: timestamptz('notified_sms_at'),
  ...auditColumns(),
});

// ---- credit_wallets (§6.1): TENANT-SCOPED, PK (tenant_id, user_id) --------
// tenant_id has no direct FK to tenants here — it's only validated via the
// composite (user_id, tenant_id) -> tenant_members FK, which stays bare per
// §0.4 (see stores.ts's ownerMemberId note for the general pattern).

export const creditWallets = pgTable(
  'credit_wallets',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    balance: integer('balance').notNull().default(0),
    portedBalance: integer('ported_balance').notNull().default(0),
    frozenAt: timestamptz('frozen_at'),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);

// ---- credit_packages (§6.3): GLOBAL, tenant_credit_packages (§6.4): TENANT-SCOPED

export const creditPackages = pgTable('credit_packages', {
  id: id(),
  code: text('code').notNull(),
  nameKey: text('name_key').notNull(),
  credits: integer('credits').notNull(),
  bonusCredits: integer('bonus_credits').notNull().default(0),
  defaultPrice: numeric('default_price', { precision: 12, scale: 2 }).notNull(),
  minPrice: numeric('min_price', { precision: 12, scale: 2 }),
  maxPrice: numeric('max_price', { precision: 12, scale: 2 }),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns(),
});

export const tenantCreditPackages = pgTable('tenant_credit_packages', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  creditPackageId: uuid('credit_package_id')
    .notNull()
    .references(() => creditPackages.id, { onDelete: 'restrict' }),
  price: numeric('price', { precision: 12, scale: 2 }),
  isEnabled: boolean('is_enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns(),
});

// ---- boost_types (§6.5): GLOBAL, tenant_boost_prices (§6.6): TENANT-SCOPED

export const boostTypes = pgTable('boost_types', {
  id: id(),
  code: text('code').notNull(),
  nameKey: text('name_key').notNull(),
  placementCode: text('placement_code')
    .notNull()
    .references(() => boostPlacements.code, { onDelete: 'restrict' }),
  targetCode: text('target_code')
    .notNull()
    .references(() => boostTargets.code, { onDelete: 'restrict' }),
  durationHours: integer('duration_hours').notNull(),
  defaultCostCredits: integer('default_cost_credits').notNull(),
  minCostCredits: integer('min_cost_credits').notNull(),
  maxCostCredits: integer('max_cost_credits').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const tenantBoostPrices = pgTable('tenant_boost_prices', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  boostTypeId: uuid('boost_type_id')
    .notNull()
    .references(() => boostTypes.id, { onDelete: 'restrict' }),
  costCredits: integer('cost_credits'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  ...auditColumns(),
});

// ---- subscription_plans (§6.8): GLOBAL, tenant_plan_prices (§6.9): TENANT-SCOPED

export const subscriptionPlans = pgTable('subscription_plans', {
  id: id(),
  code: text('code').notNull(),
  nameKey: text('name_key').notNull(),
  subjectCode: text('subject_code')
    .notNull()
    .references(() => subscriptionSubjects.code, { onDelete: 'restrict' }),
  billingIntervalCode: text('billing_interval_code')
    .notNull()
    .references(() => billingIntervals.code, { onDelete: 'restrict' }),
  defaultPrice: numeric('default_price', { precision: 12, scale: 2 }).notNull(),
  minPrice: numeric('min_price', { precision: 12, scale: 2 }).notNull(),
  maxPrice: numeric('max_price', { precision: 12, scale: 2 }).notNull(),
  includedCredits: integer('included_credits').notNull().default(0),
  entitlements: jsonb('entitlements')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns(),
});

export const tenantPlanPrices = pgTable('tenant_plan_prices', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  subscriptionPlanId: uuid('subscription_plan_id')
    .notNull()
    .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
  price: numeric('price', { precision: 12, scale: 2 }),
  isEnabled: boolean('is_enabled').notNull().default(true),
  ...auditColumns(),
});

// ---- subscriptions (§6.10): TENANT-SCOPED ----------------------------------

export const subscriptions = pgTable('subscriptions', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  subscriptionPlanId: uuid('subscription_plan_id')
    .notNull()
    .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, member_id) -> tenant_members, RESTRICT.
  memberId: uuid('member_id'),
  statusCode: text('status_code')
    .notNull()
    .default('pending_payment')
    .references(() => subscriptionStatuses.code, { onDelete: 'restrict' }),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  currentPeriodStart: timestamptz('current_period_start'),
  currentPeriodEnd: timestamptz('current_period_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  cancelledAt: timestamptz('cancelled_at'),
  graceEndsAt: timestamptz('grace_ends_at'),
  ...auditColumns(),
});

// ---- invoices (§6.11): TENANT-SCOPED ---------------------------------------

export const invoices = pgTable('invoices', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  invoiceNumber: text('invoice_number').notNull(),
  // Composite FK (tenant_id, billed_member_id) -> tenant_members, RESTRICT.
  billedMemberId: uuid('billed_member_id').notNull(),
  // Composite FK (tenant_id, billed_store_id) -> stores, RESTRICT.
  billedStoreId: uuid('billed_store_id'),
  sellerBin: text('seller_bin').notNull(),
  buyerBin: text('buyer_bin'),
  fiscalYear: text('fiscal_year').notNull(),
  taxInvoiceFormatCode: text('tax_invoice_format_code')
    .notNull()
    .references(() => taxInvoiceFormats.code, { onDelete: 'restrict' }),
  pricesIncludeVat: boolean('prices_include_vat').notNull().default(true),
  statusCode: text('status_code')
    .notNull()
    .default('draft')
    .references(() => invoiceStatuses.code, { onDelete: 'restrict' }),
  currency: char('currency', { length: 3 }).notNull().default('BDT'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  discountTotal: numeric('discount_total', { precision: 12, scale: 2 }).notNull().default('0'),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  amountPaid: numeric('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),
  amountRefunded: numeric('amount_refunded', { precision: 12, scale: 2 }).notNull().default('0'),
  issuedAt: timestamptz('issued_at'),
  dueAt: timestamptz('due_at'),
  paidAt: timestamptz('paid_at'),
  voidedAt: timestamptz('voided_at'),
  voidReason: text('void_reason'),
  ...auditColumns(),
});

// ---- ad_slots (§6.13): GLOBAL, ad_inventory (§6.14): TENANT-SCOPED --------

export const adSlots = pgTable('ad_slots', {
  id: id(),
  code: text('code').notNull(),
  nameKey: text('name_key').notNull(),
  surfaceCode: text('surface_code')
    .notNull()
    .references(() => adSurfaces.code, { onDelete: 'restrict' }),
  widthPx: integer('width_px').notNull(),
  heightPx: integer('height_px').notNull(),
  maxPositions: smallint('max_positions').notNull().default(1),
  supportsCategoryTargeting: boolean('supports_category_targeting').notNull().default(false),
  defaultPricePerDay: numeric('default_price_per_day', { precision: 12, scale: 2 }).notNull(),
  minPricePerDay: numeric('min_price_per_day', { precision: 12, scale: 2 }).notNull(),
  maxPricePerDay: numeric('max_price_per_day', { precision: 12, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const adInventory = pgTable('ad_inventory', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  adSlotId: uuid('ad_slot_id')
    .notNull()
    .references(() => adSlots.id, { onDelete: 'restrict' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'restrict' }),
  positions: smallint('positions').notNull().default(1),
  pricePerDay: numeric('price_per_day', { precision: 12, scale: 2 }).notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  ...auditColumns(),
});

// ---- ad_creatives (§6.15): TENANT-SCOPED -----------------------------------

export const adCreatives = pgTable('ad_creatives', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, advertiser_member_id) -> tenant_members, RESTRICT.
  advertiserMemberId: uuid('advertiser_member_id').notNull(),
  // Composite FK (tenant_id, store_id) -> stores, SET NULL.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, media_asset_id) -> media_assets, RESTRICT.
  mediaAssetId: uuid('media_asset_id').notNull(),
  headline: text('headline'),
  targetUrl: text('target_url'),
  statusCode: text('status_code')
    .notNull()
    .default('pending_review')
    .references(() => adCreativeStatuses.code, { onDelete: 'restrict' }),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  reviewedAt: timestamptz('reviewed_at'),
  rejectionReasonCode: text('rejection_reason_code').references(() => moderationReasons.code, {
    onDelete: 'restrict',
  }),
  ...softDeleteColumns(),
});

// ---- ad_bookings (§6.16): TENANT-SCOPED ------------------------------------

export const adBookings = pgTable('ad_bookings', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, ad_inventory_id) -> ad_inventory, RESTRICT.
  adInventoryId: uuid('ad_inventory_id').notNull(),
  // Composite FK (tenant_id, ad_creative_id) -> ad_creatives, RESTRICT.
  adCreativeId: uuid('ad_creative_id').notNull(),
  // Composite FK (tenant_id, advertiser_member_id) -> tenant_members, RESTRICT.
  advertiserMemberId: uuid('advertiser_member_id').notNull(),
  position: smallint('position').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  pricePerDay: numeric('price_per_day', { precision: 12, scale: 2 }).notNull(),
  totalPrice: numeric('total_price', { precision: 12, scale: 2 }).notNull(),
  // Composite FK (tenant_id, invoice_id) -> invoices, RESTRICT.
  invoiceId: uuid('invoice_id'),
  statusCode: text('status_code')
    .notNull()
    .default('held')
    .references(() => adBookingStatuses.code, { onDelete: 'restrict' }),
  holdExpiresAt: timestamptz('hold_expires_at'),
  bookedByUserId: uuid('booked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...auditColumns(),
});

// ---- ad_daily_stats (§6.17): TENANT-SCOPED ---------------------------------

export const adDailyStats = pgTable('ad_daily_stats', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, ad_booking_id) -> ad_bookings, CASCADE.
  adBookingId: uuid('ad_booking_id').notNull(),
  statDate: date('stat_date').notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  ...auditColumns(),
});

// ---- invoice_lines (§6.12): TENANT-SCOPED ----------------------------------

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, invoice_id) -> invoices, CASCADE.
  invoiceId: uuid('invoice_id').notNull(),
  lineTypeCode: text('line_type_code')
    .notNull()
    .references(() => invoiceLineTypes.code, { onDelete: 'restrict' }),
  revenueStreamCode: text('revenue_stream_code')
    .notNull()
    .references(() => revenueStreams.code, { onDelete: 'restrict' }),
  descriptionKey: text('description_key').notNull(),
  descriptionParams: jsonb('description_params')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  quantity: integer('quantity').notNull().default(1),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  discount: numeric('discount', { precision: 12, scale: 2 }).notNull().default('0'),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull(),
  vatRate: numeric('vat_rate', { precision: 5, scale: 4 }).notNull(),
  vatAmount: numeric('vat_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  creditPackageId: uuid('credit_package_id').references(() => creditPackages.id, {
    onDelete: 'restrict',
  }),
  // Composite FK (tenant_id, subscription_id) -> subscriptions, RESTRICT.
  subscriptionId: uuid('subscription_id'),
  // Composite FK (tenant_id, ad_booking_id) -> ad_bookings, RESTRICT.
  adBookingId: uuid('ad_booking_id'),
  ...auditColumns(),
});

// ---- credit_transactions (§6.2): TENANT-SCOPED, append-only ledger --------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, user_id) -> credit_wallets FK, which stays bare.

export const creditTransactions = pgTable('credit_transactions', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, user_id) -> credit_wallets, RESTRICT.
  userId: uuid('user_id').notNull(),
  amount: integer('amount').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => creditReasons.code, { onDelete: 'restrict' }),
  isPurchased: boolean('is_purchased').notNull().default(false),
  originTenantId: uuid('origin_tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  platformShareRateProvisional: numeric('platform_share_rate_provisional', {
    precision: 5,
    scale: 4,
  }),
  platformShareRateFinal: numeric('platform_share_rate_final', { precision: 9, scale: 8 }),
  platformShareBdtFinal: numeric('platform_share_bdt_final', { precision: 12, scale: 2 }),
  creditClosureDispositionId: uuid('credit_closure_disposition_id').references(
    () => creditClosureDispositions.id,
    { onDelete: 'restrict' },
  ),
  // Composite FK (tenant_id, payment_id) -> payments, RESTRICT.
  paymentId: uuid('payment_id'),
  // Composite FK (tenant_id, invoice_id) -> invoices, RESTRICT.
  invoiceId: uuid('invoice_id'),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT.
  postId: uuid('post_id'),
  // Composite FK (tenant_id, subscription_id) -> subscriptions, RESTRICT.
  subscriptionId: uuid('subscription_id'),
  // Composite FK (tenant_id, reverses_transaction_id) -> credit_transactions
  // (self), RESTRICT.
  reversesTransactionId: uuid('reverses_transaction_id'),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  note: text('note'),
  idempotencyKey: text('idempotency_key').notNull(),
  ...auditColumns(),
});

// ---- credit_lots (§6.18): TENANT-SCOPED ------------------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, user_id) -> credit_wallets FK, which stays bare.

export const creditLots = pgTable('credit_lots', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, user_id) -> credit_wallets, RESTRICT.
  userId: uuid('user_id').notNull(),
  // Composite FK (tenant_id, source_transaction_id) -> credit_transactions, RESTRICT.
  sourceTransactionId: uuid('source_transaction_id').notNull(),
  isPurchased: boolean('is_purchased').notNull(),
  creditsGranted: integer('credits_granted').notNull(),
  creditsRemaining: integer('credits_remaining').notNull(),
  purchaseAmountBdt: numeric('purchase_amount_bdt', { precision: 12, scale: 2 }),
  valueRemainingBdt: numeric('value_remaining_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  // Composite FK (tenant_id, payment_id) -> payments, RESTRICT.
  paymentId: uuid('payment_id'),
  originTenantId: uuid('origin_tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  // Plain FK (may cross tenants), per §6.18's Keys line.
  purchaseTransactionId: uuid('purchase_transaction_id').references(() => creditTransactions.id, {
    onDelete: 'restrict',
  }),
  soldUnderPartnerId: uuid('sold_under_partner_id').references(() => partners.id, {
    onDelete: 'restrict',
  }),
  expiresAt: timestamptz('expires_at'),
  // Plain FK (cross-tenant), self-referential.
  originLotId: uuid('origin_lot_id').references((): AnyPgColumn => creditLots.id, {
    onDelete: 'restrict',
  }),
  originallyPurchasedAt: timestamptz('originally_purchased_at'),
  ...auditColumns(),
});

// ---- credit_lot_allocations (§6.19): TENANT-SCOPED, immutable -------------
// tenant_id has no direct FK to tenants — validated transitively via the
// two composite FKs below, which stay bare.

export const creditLotAllocations = pgTable('credit_lot_allocations', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, credit_transaction_id) -> credit_transactions, RESTRICT.
  creditTransactionId: uuid('credit_transaction_id').notNull(),
  // Composite FK (tenant_id, credit_lot_id) -> credit_lots, RESTRICT.
  creditLotId: uuid('credit_lot_id').notNull(),
  credits: integer('credits').notNull(),
  valueBdt: numeric('value_bdt', { precision: 12, scale: 2 }).notNull().default('0'),
  ...auditColumns(),
});

// ---- tenant_credit_liability (§6.20): TENANT-SCOPED, 1:1 with tenants -----

export const tenantCreditLiability = pgTable('tenant_credit_liability', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  outstandingCredits: bigint('outstanding_credits', { mode: 'number' }).notNull().default(0),
  outstandingPurchasedCredits: bigint('outstanding_purchased_credits', { mode: 'number' })
    .notNull()
    .default(0),
  liabilityBdt: numeric('liability_bdt', { precision: 12, scale: 2 }).notNull().default('0'),
  portedOutstandingCredits: bigint('ported_outstanding_credits', { mode: 'number' })
    .notNull()
    .default(0),
  portedLiabilityBdt: numeric('ported_liability_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  ...auditColumns(),
});

// ---- platform_credit_pool (§6.21): GLOBAL ----------------------------------

export const platformCreditPool = pgTable('platform_credit_pool', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  originTenantId: uuid('origin_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  originLotId: uuid('origin_lot_id')
    .notNull()
    .references(() => creditLots.id, { onDelete: 'restrict' }),
  creditClosureDispositionId: uuid('credit_closure_disposition_id')
    .notNull()
    .references(() => creditClosureDispositions.id, { onDelete: 'restrict' }),
  isPurchased: boolean('is_purchased').notNull(),
  credits: integer('credits').notNull(),
  valueBdt: numeric('value_bdt', { precision: 12, scale: 2 }).notNull().default('0'),
  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('held')
    .references(() => creditPoolStatuses.code, { onDelete: 'restrict' }),
  parkedAt: timestamptz('parked_at').notNull().defaultNow(),
  restoredAt: timestamptz('restored_at'),
  restoredToTenantId: uuid('restored_to_tenant_id').references(() => tenants.id, {
    onDelete: 'restrict',
  }),
  restoreTransactionId: uuid('restore_transaction_id').references(() => creditTransactions.id, {
    onDelete: 'restrict',
  }),
  refundedAt: timestamptz('refunded_at'),
  refundId: uuid('refund_id').references(() => refunds.id, { onDelete: 'restrict' }),
  ...auditColumns(),
});

// ---- credit_liability_settlements (§6.23): GLOBAL, immutable except true-up

export const creditLiabilitySettlements = pgTable('credit_liability_settlements', {
  id: id(),
  settlementKindCode: text('settlement_kind_code')
    .notNull()
    .references(() => liabilitySettlementKinds.code, { onDelete: 'restrict' }),
  fromTenantId: uuid('from_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  toTenantId: uuid('to_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  fromPartnerId: uuid('from_partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  toPartnerId: uuid('to_partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  credits: integer('credits').notNull(),
  creditValueBdt: numeric('credit_value_bdt', { precision: 12, scale: 2 }).notNull(),
  originRate: numeric('origin_rate', { precision: 9, scale: 8 }).notNull(),
  originRateIsFinal: boolean('origin_rate_is_final').notNull(),
  spenderRate: numeric('spender_rate', { precision: 9, scale: 8 }).notNull(),
  spenderRateIsFinal: boolean('spender_rate_is_final').notNull(),
  payoutRate: numeric('payout_rate', { precision: 9, scale: 8 }).notNull(),
  payoutBdt: numeric('payout_bdt', { precision: 12, scale: 2 }).notNull(),
  reserveFundedBdt: numeric('reserve_funded_bdt', { precision: 12, scale: 2 }).notNull(),
  continuitySubsidyBdt: numeric('continuity_subsidy_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  subsidyCapped: boolean('subsidy_capped').notNull().default(false),
  creditTransactionId: uuid('credit_transaction_id')
    .notNull()
    .references(() => creditTransactions.id, { onDelete: 'restrict' }),
  creditLotId: uuid('credit_lot_id')
    .notNull()
    .references(() => creditLots.id, { onDelete: 'restrict' }),
  journalId: uuid('journal_id').notNull(), // FK added with settlement_ledger_entries (0008)
  settledAt: timestamptz('settled_at').notNull().defaultNow(),
  truedUpAt: timestamptz('trued_up_at'),
  trueUpDeltaBdt: numeric('true_up_delta_bdt', { precision: 12, scale: 2 }),
  ...auditColumns(),
});

// ---- boosts (§6.7): TENANT-SCOPED ------------------------------------------

export const boosts = pgTable('boosts', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  boostTypeId: uuid('boost_type_id')
    .notNull()
    .references(() => boostTypes.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT.
  postId: uuid('post_id'),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, purchased_by_member_id) -> tenant_members, RESTRICT.
  purchasedByMemberId: uuid('purchased_by_member_id').notNull(),
  startsAt: timestamptz('starts_at').notNull(),
  endsAt: timestamptz('ends_at').notNull(),
  costCredits: integer('cost_credits').notNull(),
  // Composite FK (tenant_id, credit_transaction_id) -> credit_transactions, RESTRICT.
  creditTransactionId: uuid('credit_transaction_id'),
  statusCode: text('status_code')
    .notNull()
    .default('scheduled')
    .references(() => boostStatuses.code, { onDelete: 'restrict' }),
  cancelledAt: timestamptz('cancelled_at'),
  stoppedAt: timestamptz('stopped_at'),
  stopReasonCode: text('stop_reason_code').references(() => boostStopReasons.code, {
    onDelete: 'restrict',
  }),
  ...auditColumns(),
});

// ---- boost_vouchers (§6.24): TENANT-SCOPED ---------------------------------

export const boostVouchers = pgTable('boost_vouchers', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (user_id, tenant_id) -> tenant_members, RESTRICT.
  userId: uuid('user_id').notNull(),
  // Composite FK (tenant_id, source_boost_id) -> boosts, RESTRICT.
  sourceBoostId: uuid('source_boost_id').notNull(),
  boostTypeId: uuid('boost_type_id')
    .notNull()
    .references(() => boostTypes.id, { onDelete: 'restrict' }),
  remainingDays: integer('remaining_days').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  consumedAt: timestamptz('consumed_at'),
  // Composite FK (tenant_id, consumed_by_boost_id) -> boosts, RESTRICT.
  consumedByBoostId: uuid('consumed_by_boost_id'),
  ...auditColumns(),
});

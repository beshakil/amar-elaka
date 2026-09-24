import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, id, timestamptz } from './columns';
import {
  finalSettlementStatuses,
  ledgerAccounts,
  paymentEventDirections,
  paymentProviders,
  paymentStatuses,
  payoutDirections,
  payoutMethods,
  payoutStatuses,
  refundChannels,
  refundReasons,
  refundStatuses,
  revenueBases,
  revenueCalcMethods,
  revenueStreams,
  settlementPeriodStatuses,
  settlementStatuses,
  tenantClosureTypes,
} from './enums';
import { users } from './identity';
import { partners, partnerPayoutAccounts } from './partners';
import { tenants } from './tenancy';

// ---- payments (§7.1): GLOBAL with a nullable tenant_id --------------------

export const payments = pgTable('payments', {
  id: id(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, invoice_id) -> invoices, RESTRICT.
  invoiceId: uuid('invoice_id'),
  payerUserId: uuid('payer_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  providerCode: text('provider_code')
    .notNull()
    .references(() => paymentProviders.code, { onDelete: 'restrict' }),
  providerPaymentId: text('provider_payment_id'),
  providerTrxId: text('provider_trx_id'),
  payerAccountMasked: text('payer_account_masked'),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('BDT'),
  gatewayFee: numeric('gateway_fee', { precision: 12, scale: 2 }).notNull().default('0'),
  // STORED generated column; Postgres does not infer NOT NULL for it even
  // though amount/gateway_fee both are, so it stays nullable here too.
  netAmount: numeric('net_amount', { precision: 12, scale: 2 }).generatedAlwaysAs(
    sql`(amount - gateway_fee)`,
  ),
  statusCode: text('status_code')
    .notNull()
    .default('initiated')
    .references(() => paymentStatuses.code, { onDelete: 'restrict' }),
  failureCode: text('failure_code'),
  failureDetail: text('failure_detail'),
  // Composite FKs (tenant_id, *) -> field_agents / agent_cash_remittances,
  // both RESTRICT (0012). A CHECK also requires tenant_id set whenever
  // either of these is set (payments.tenant_id is otherwise nullable).
  collectedByAgentId: uuid('collected_by_agent_id'),
  agentRemittanceId: uuid('agent_remittance_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  initiatedAt: timestamptz('initiated_at').notNull().defaultNow(),
  succeededAt: timestamptz('succeeded_at'),
  ledgerPostedAt: timestamptz('ledger_posted_at'),
  metadata: jsonb('metadata')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  ...auditColumns(),
});

// ---- payment_events (§7.2): GLOBAL, system-only ----------------------------

export const paymentEvents = pgTable('payment_events', {
  id: id(),
  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
  providerCode: text('provider_code')
    .notNull()
    .references(() => paymentProviders.code, { onDelete: 'restrict' }),
  providerEventId: text('provider_event_id'),
  directionCode: text('direction_code')
    .notNull()
    .references(() => paymentEventDirections.code, { onDelete: 'restrict' }),
  eventType: text('event_type').notNull(),
  httpStatus: integer('http_status'),
  signatureValid: boolean('signature_valid'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamptz('received_at').notNull().defaultNow(),
  processedAt: timestamptz('processed_at'),
  processingError: text('processing_error'),
  ...auditColumns(),
});

// ---- refunds (§7.3): GLOBAL -------------------------------------------------

export const refunds = pgTable('refunds', {
  id: id(),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'restrict' }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => refundReasons.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('requested')
    .references(() => refundStatuses.code, { onDelete: 'restrict' }),
  refundChannelCode: text('refund_channel_code')
    .notNull()
    .default('original_method')
    .references(() => refundChannels.code, { onDelete: 'restrict' }),
  payoutDestinationMasked: text('payout_destination_masked'),
  destinationVerifiedAt: timestamptz('destination_verified_at'),
  dueBy: timestamptz('due_by').notNull(),
  reserveFundedBdt: numeric('reserve_funded_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  platformShareReturnedBdt: numeric('platform_share_returned_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  gatewayFeeAbsorbedBdt: numeric('gateway_fee_absorbed_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  providerRefundId: text('provider_refund_id'),
  requestedByUserId: uuid('requested_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  approvedAt: timestamptz('approved_at'),
  succeededAt: timestamptz('succeeded_at'),
  note: text('note'),
  idempotencyKey: text('idempotency_key').notNull(),
  ...auditColumns(),
});

// ---- revenue_share_schemes (§7.4) / revenue_share_slabs (§7.5): GLOBAL ----

export const revenueShareSchemes = pgTable('revenue_share_schemes', {
  id: id(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  calculationMethodCode: text('calculation_method_code')
    .notNull()
    .default('tiered_marginal')
    .references(() => revenueCalcMethods.code, { onDelete: 'restrict' }),
  basisCode: text('basis_code')
    .notNull()
    .default('net_of_vat_fees_and_refunds')
    .references(() => revenueBases.code, { onDelete: 'restrict' }),
  isDefault: boolean('is_default').notNull().default(false),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  ...auditColumns(),
});

export const revenueShareSlabs = pgTable('revenue_share_slabs', {
  id: id(),
  schemeId: uuid('scheme_id')
    .notNull()
    .references(() => revenueShareSchemes.id, { onDelete: 'restrict' }),
  revenueStreamCode: text('revenue_stream_code').references(() => revenueStreams.code, {
    onDelete: 'restrict',
  }),
  lowerBound: numeric('lower_bound', { precision: 12, scale: 2 }).notNull(),
  upperBound: numeric('upper_bound', { precision: 12, scale: 2 }),
  partnerSharePct: numeric('partner_share_pct', { precision: 5, scale: 2 }).notNull(),
  ...auditColumns(),
});

// ---- tenant_revenue_overrides (§7.6): TENANT-SCOPED ------------------------

export const tenantRevenueOverrides = pgTable('tenant_revenue_overrides', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  revenueStreamCode: text('revenue_stream_code').references(() => revenueStreams.code, {
    onDelete: 'restrict',
  }),
  schemeId: uuid('scheme_id').references(() => revenueShareSchemes.id, { onDelete: 'restrict' }),
  flatPartnerSharePct: numeric('flat_partner_share_pct', { precision: 5, scale: 2 }),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  reason: text('reason').notNull(),
  approvedByUserId: uuid('approved_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  ...auditColumns(),
});

// ---- settlement_periods (§7.7): GLOBAL -------------------------------------

export const settlementPeriods = pgTable('settlement_periods', {
  id: id(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  statusCode: text('status_code')
    .notNull()
    .default('open')
    .references(() => settlementPeriodStatuses.code, { onDelete: 'restrict' }),
  closedAt: timestamptz('closed_at'),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  approvedAt: timestamptz('approved_at'),
  ...auditColumns(),
});

// ---- settlements (§7.8): TENANT-SCOPED -------------------------------------

export const settlements = pgTable('settlements', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  settlementPeriodId: uuid('settlement_period_id')
    .notNull()
    .references(() => settlementPeriods.id, { onDelete: 'restrict' }),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('draft')
    .references(() => settlementStatuses.code, { onDelete: 'restrict' }),
  grossRevenue: numeric('gross_revenue', { precision: 12, scale: 2 }).notNull().default('0'),
  gatewayFees: numeric('gateway_fees', { precision: 12, scale: 2 }).notNull().default('0'),
  refundsTotal: numeric('refunds_total', { precision: 12, scale: 2 }).notNull().default('0'),
  revenueBasis: numeric('revenue_basis', { precision: 12, scale: 2 }).notNull().default('0'),
  portedCreditRevenue: numeric('ported_credit_revenue', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  partnerShare: numeric('partner_share', { precision: 12, scale: 2 }).notNull().default('0'),
  platformShare: numeric('platform_share', { precision: 12, scale: 2 }).notNull().default('0'),
  cashHeldByPartner: numeric('cash_held_by_partner', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  adjustmentsTotal: numeric('adjustments_total', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  carriedForwardIn: numeric('carried_forward_in', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  netPayable: numeric('net_payable', { precision: 12, scale: 2 }).notNull().default('0'),
  calculationSnapshot: jsonb('calculation_snapshot')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  calculatedAt: timestamptz('calculated_at'),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  approvedAt: timestamptz('approved_at'),
  disputeNote: text('dispute_note'),
  disputedAt: timestamptz('disputed_at'),
  ...auditColumns(),
});

// ---- payouts (§7.10): TENANT-SCOPED ----------------------------------------
// Created before settlement_ledger_entries in the migration so the latter's
// composite FK to it is real, not deferred; kept in that order here too.

export const payouts = pgTable('payouts', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, settlement_id) -> settlements, RESTRICT.
  settlementId: uuid('settlement_id').notNull(),
  directionCode: text('direction_code')
    .notNull()
    .default('to_partner')
    .references(() => payoutDirections.code, { onDelete: 'restrict' }),
  partnerPayoutAccountId: uuid('partner_payout_account_id').references(
    () => partnerPayoutAccounts.id,
    {
      onDelete: 'restrict',
    },
  ),
  accountSnapshot: jsonb('account_snapshot')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  withholdingVatBdt: numeric('withholding_vat_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  withholdingTaxBdt: numeric('withholding_tax_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  withholdingCertificateKey: text('withholding_certificate_key'),
  methodCode: text('method_code')
    .notNull()
    .references(() => payoutMethods.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('pending')
    .references(() => payoutStatuses.code, { onDelete: 'restrict' }),
  externalReference: text('external_reference'),
  sentAt: timestamptz('sent_at'),
  confirmedAt: timestamptz('confirmed_at'),
  initiatedByUserId: uuid('initiated_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  ...auditColumns(),
});

// ---- settlement_ledger_entries (§7.9): TENANT-SCOPED, immutable -----------

export const settlementLedgerEntries = pgTable('settlement_ledger_entries', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Correlation id shared by every balanced leg of one event, not a row FK.
  journalId: uuid('journal_id').notNull(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  accountCode: text('account_code')
    .notNull()
    .references(() => ledgerAccounts.code, { onDelete: 'restrict' }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  revenueStreamCode: text('revenue_stream_code').references(() => revenueStreams.code, {
    onDelete: 'restrict',
  }),
  occurredAt: timestamptz('occurred_at').notNull(),
  // Composite FK (tenant_id, settlement_id) -> settlements, RESTRICT.
  settlementId: uuid('settlement_id'),
  // Composite FK (tenant_id, payment_id) -> payments, RESTRICT.
  paymentId: uuid('payment_id'),
  refundId: uuid('refund_id').references(() => refunds.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, payout_id) -> payouts, RESTRICT.
  payoutId: uuid('payout_id'),
  memo: text('memo'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  idempotencyKey: text('idempotency_key').notNull(),
  ...auditColumns(),
});

// ---- tenant_final_settlement (§7.11): TENANT-SCOPED ------------------------

export const tenantFinalSettlement = pgTable('tenant_final_settlement', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  closureTypeCode: text('closure_type_code')
    .notNull()
    .references(() => tenantClosureTypes.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, tenant_transfer_id) -> tenant_transfers, RESTRICT.
  tenantTransferId: uuid('tenant_transfer_id'),
  incomingPartnerId: uuid('incoming_partner_id').references(() => partners.id, {
    onDelete: 'restrict',
  }),
  cutoffAt: timestamptz('cutoff_at').notNull(),
  // Composite FK (tenant_id, last_settlement_id) -> settlements, RESTRICT.
  lastSettlementId: uuid('last_settlement_id'),
  grossOwed: numeric('gross_owed', { precision: 12, scale: 2 }).notNull().default('0'),
  totalLiabilityBdt: numeric('total_liability_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  liabilityDeduction: numeric('liability_deduction', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  platformShareRetainedBdt: numeric('platform_share_retained_bdt', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  liabilityHandoverAmount: numeric('liability_handover_amount', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  platformFrontedAmount: numeric('platform_fronted_amount', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  liabilityCalculation: jsonb('liability_calculation')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  netPayable: numeric('net_payable', { precision: 12, scale: 2 }).notNull().default('0'),
  statusCode: text('status_code')
    .notNull()
    .default('draft')
    .references(() => finalSettlementStatuses.code, { onDelete: 'restrict' }),
  // Composite FKs (tenant_id, *_id) -> payouts, RESTRICT.
  payoutId: uuid('payout_id'),
  receivablePayoutId: uuid('receivable_payout_id'),
  writeOffReason: text('write_off_reason'),
  // Correlation id (settlement_ledger_entries.journal_id), not a row FK.
  liabilityJournalId: uuid('liability_journal_id'),
  calculatedAt: timestamptz('calculated_at'),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
  approvedAt: timestamptz('approved_at'),
  settledAt: timestamptz('settled_at'),
  ...auditColumns(),
});

// ---- platform_share_rate_backfills (§7.12): TENANT-SCOPED ------------------

export const platformShareRateBackfills = pgTable('platform_share_rate_backfills', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  settlementPeriodId: uuid('settlement_period_id')
    .notNull()
    .references(() => settlementPeriods.id, { onDelete: 'restrict' }),
  creditBasisBdt: numeric('credit_basis_bdt', { precision: 12, scale: 2 }).notNull(),
  ledgerPlatformShareBdt: numeric('ledger_platform_share_bdt', {
    precision: 12,
    scale: 2,
  }).notNull(),
  blendedRateExact: numeric('blended_rate_exact').notNull(),
  platformShareRateFinal: numeric('platform_share_rate_final', {
    precision: 9,
    scale: 8,
  }).notNull(),
  allocatedPlatformShareBdt: numeric('allocated_platform_share_bdt', {
    precision: 12,
    scale: 2,
  }).notNull(),
  transactionsUpdated: integer('transactions_updated').notNull(),
  trueUpsPosted: integer('true_ups_posted').notNull().default(0),
  runAt: timestamptz('run_at').notNull().defaultNow(),
  ...auditColumns(),
});

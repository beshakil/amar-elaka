-- 0008_payments_revenue
--
-- Payments & revenue share domain (docs/specs/schema.md §7): payment
-- collection, refunds, the revenue-share scheme/slab pricing model, the
-- settlement calendar and per-tenant statements, the double-entry
-- settlement ledger, payouts, a partner's final reckoning on
-- termination/transfer, and the monthly platform-share rate backfill.
-- Runs as ae_migrator; RLS and grants are in this same file.
--
-- Closes six deferred FKs now that their targets exist:
--   - invoices.tax_invoice_format_code -> tax_invoice_formats (0007)
--   - credit_transactions.payment_id -> payments, composite (0007)
--   - credit_lots.payment_id -> payments, composite (0007)
--   - platform_credit_pool.payment_id -> payments, plain (0007)
--   - platform_credit_pool.refund_id -> refunds, plain (0007)
--   - tenant_transfers.final_settlement_id -> settlements, composite (0003)
-- `credit_liability_settlements.journal_id`, `settlement_ledger_entries.
-- journal_id` itself and `tenant_transfers.liability_journal_id` stay bare:
-- a journal_id is a correlation value shared by every balanced leg of one
-- event, not a single row's key, so there is no row for it to reference.
--
-- ============================================================================
-- SCOPE — as with 0007: full DDL/CHECKs/indexes/RLS for every table, every
-- self-contained trigger (immutability, balance-check, tenant/partner
-- consistency). NOT built here, for the same reason as 0007's ledger engine
-- — each is substantial orchestration logic that deserves its own pass:
--   - The webhook handler, reconciliation job, and settlement/payout run
--     that actually write payments/refunds/settlements/payouts rows.
--   - revenue_share_schemes' "immutable once referenced by a non-draft
--     settlement": settlements has no FK column to a scheme (the scheme
--     used is recorded only inside `calculation_snapshot` jsonb, per spec),
--     so there is no queryable link for a trigger to check. Left to the
--     settlement-calculation service, which controls when a scheme is
--     touched relative to snapshotting it.
--   - refunds' exact approval-threshold routing (tenant_admin up to
--     tenant_refund_approval_limit_bdt, platform above that and for every
--     verified_manual_payout): a `platform_settings` value read through
--     SettingsService (CLAUDE.md rule 9), not something RLS can enforce.
--     RLS here provides the coarser backstop (a tenant_admin may only touch
--     their own tenant's refunds); the exact routing is service-enforced.
--   - backfill_platform_share_rates(period) itself (§7.12) and the payout
--     run that actually pays a settlement.
-- ============================================================================

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.tax_invoice_formats (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_invoice_formats_pk PRIMARY KEY (code), CONSTRAINT tax_invoice_formats_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER tax_invoice_formats_set_updated_at BEFORE UPDATE ON public.tax_invoice_formats FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- Exact NBR Mushak form(s) to be confirmed with the accountant (spec §7,
-- invoices.tax_invoice_format_code); 'standard' is a provisional single
-- value so the NOT NULL column is usable, not a real tax-form code yet.
INSERT INTO public.tax_invoice_formats (code, label_key, sort_order) VALUES
  ('standard', 'enum.tax_invoice_formats.standard', 10);
--> statement-breakpoint

CREATE TABLE public.refund_channels (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_channels_pk PRIMARY KEY (code), CONSTRAINT refund_channels_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER refund_channels_set_updated_at BEFORE UPDATE ON public.refund_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.refund_channels (code, label_key, sort_order) VALUES
  ('original_method', 'enum.refund_channels.original_method', 10),
  ('verified_manual_payout', 'enum.refund_channels.verified_manual_payout', 20);
--> statement-breakpoint

CREATE TABLE public.tenant_closure_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_closure_types_pk PRIMARY KEY (code), CONSTRAINT tenant_closure_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER tenant_closure_types_set_updated_at BEFORE UPDATE ON public.tenant_closure_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.tenant_closure_types (code, label_key, sort_order) VALUES
  ('termination', 'enum.tenant_closure_types.termination', 10),
  ('transfer', 'enum.tenant_closure_types.transfer', 20);
--> statement-breakpoint

CREATE TABLE public.final_settlement_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT final_settlement_statuses_pk PRIMARY KEY (code), CONSTRAINT final_settlement_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER final_settlement_statuses_set_updated_at BEFORE UPDATE ON public.final_settlement_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.final_settlement_statuses (code, label_key, sort_order) VALUES
  ('draft', 'enum.final_settlement_statuses.draft', 10),
  ('calculated', 'enum.final_settlement_statuses.calculated', 20),
  ('approved', 'enum.final_settlement_statuses.approved', 30),
  ('paid', 'enum.final_settlement_statuses.paid', 40),
  ('receivable_open', 'enum.final_settlement_statuses.receivable_open', 50),
  ('receivable_collected', 'enum.final_settlement_statuses.receivable_collected', 60),
  ('written_off', 'enum.final_settlement_statuses.written_off', 70);
--> statement-breakpoint

CREATE TABLE public.payment_providers (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_providers_pk PRIMARY KEY (code), CONSTRAINT payment_providers_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER payment_providers_set_updated_at BEFORE UPDATE ON public.payment_providers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.payment_providers (code, label_key, sort_order) VALUES
  ('bkash', 'enum.payment_providers.bkash', 10),
  ('nagad', 'enum.payment_providers.nagad', 20),
  ('sslcommerz', 'enum.payment_providers.sslcommerz', 30),
  ('cash_agent', 'enum.payment_providers.cash_agent', 40),
  ('bank_transfer', 'enum.payment_providers.bank_transfer', 50);
--> statement-breakpoint

CREATE TABLE public.payment_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_statuses_pk PRIMARY KEY (code), CONSTRAINT payment_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER payment_statuses_set_updated_at BEFORE UPDATE ON public.payment_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.payment_statuses (code, label_key, sort_order) VALUES
  ('initiated', 'enum.payment_statuses.initiated', 10),
  ('pending', 'enum.payment_statuses.pending', 20),
  ('succeeded', 'enum.payment_statuses.succeeded', 30),
  ('failed', 'enum.payment_statuses.failed', 40),
  ('cancelled', 'enum.payment_statuses.cancelled', 50),
  ('expired', 'enum.payment_statuses.expired', 60),
  ('refunded', 'enum.payment_statuses.refunded', 70),
  ('partially_refunded', 'enum.payment_statuses.partially_refunded', 80);
--> statement-breakpoint

CREATE TABLE public.payment_event_directions (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_event_directions_pk PRIMARY KEY (code), CONSTRAINT payment_event_directions_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER payment_event_directions_set_updated_at BEFORE UPDATE ON public.payment_event_directions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.payment_event_directions (code, label_key, sort_order) VALUES
  ('inbound_webhook', 'enum.payment_event_directions.inbound_webhook', 10),
  ('outbound_request', 'enum.payment_event_directions.outbound_request', 20),
  ('outbound_response', 'enum.payment_event_directions.outbound_response', 30),
  ('poll', 'enum.payment_event_directions.poll', 40);
--> statement-breakpoint

CREATE TABLE public.refund_reasons (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_reasons_pk PRIMARY KEY (code), CONSTRAINT refund_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER refund_reasons_set_updated_at BEFORE UPDATE ON public.refund_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.refund_reasons (code, label_key, sort_order) VALUES
  ('payment_error', 'enum.refund_reasons.payment_error', 10),
  ('service_not_delivered', 'enum.refund_reasons.service_not_delivered', 20),
  ('tenant_closure_credit_refund', 'enum.refund_reasons.tenant_closure_credit_refund', 30),
  ('goodwill', 'enum.refund_reasons.goodwill', 40);
--> statement-breakpoint

CREATE TABLE public.refund_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_statuses_pk PRIMARY KEY (code), CONSTRAINT refund_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER refund_statuses_set_updated_at BEFORE UPDATE ON public.refund_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.refund_statuses (code, label_key, sort_order) VALUES
  ('requested', 'enum.refund_statuses.requested', 10),
  ('approved', 'enum.refund_statuses.approved', 20),
  ('processing', 'enum.refund_statuses.processing', 30),
  ('succeeded', 'enum.refund_statuses.succeeded', 40),
  ('failed', 'enum.refund_statuses.failed', 50),
  ('rejected', 'enum.refund_statuses.rejected', 60);
--> statement-breakpoint

CREATE TABLE public.revenue_calc_methods (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_calc_methods_pk PRIMARY KEY (code), CONSTRAINT revenue_calc_methods_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER revenue_calc_methods_set_updated_at BEFORE UPDATE ON public.revenue_calc_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.revenue_calc_methods (code, label_key, sort_order) VALUES
  ('tiered_marginal', 'enum.revenue_calc_methods.tiered_marginal', 10),
  ('tiered_whole', 'enum.revenue_calc_methods.tiered_whole', 20);
--> statement-breakpoint

CREATE TABLE public.revenue_bases (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_bases_pk PRIMARY KEY (code), CONSTRAINT revenue_bases_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER revenue_bases_set_updated_at BEFORE UPDATE ON public.revenue_bases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.revenue_bases (code, label_key, sort_order) VALUES
  ('net_of_vat_fees_and_refunds', 'enum.revenue_bases.net_of_vat_fees_and_refunds', 10),
  ('net_of_fees_and_refunds', 'enum.revenue_bases.net_of_fees_and_refunds', 20),
  ('gross', 'enum.revenue_bases.gross', 30);
--> statement-breakpoint

CREATE TABLE public.settlement_period_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_period_statuses_pk PRIMARY KEY (code), CONSTRAINT settlement_period_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER settlement_period_statuses_set_updated_at BEFORE UPDATE ON public.settlement_period_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.settlement_period_statuses (code, label_key, sort_order) VALUES
  ('open', 'enum.settlement_period_statuses.open', 10),
  ('closing', 'enum.settlement_period_statuses.closing', 20),
  ('calculated', 'enum.settlement_period_statuses.calculated', 30),
  ('approved', 'enum.settlement_period_statuses.approved', 40),
  ('paid', 'enum.settlement_period_statuses.paid', 50);
--> statement-breakpoint

CREATE TABLE public.settlement_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_statuses_pk PRIMARY KEY (code), CONSTRAINT settlement_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER settlement_statuses_set_updated_at BEFORE UPDATE ON public.settlement_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.settlement_statuses (code, label_key, sort_order) VALUES
  ('draft', 'enum.settlement_statuses.draft', 10),
  ('calculated', 'enum.settlement_statuses.calculated', 20),
  ('approved', 'enum.settlement_statuses.approved', 30),
  ('disputed', 'enum.settlement_statuses.disputed', 40),
  ('paid', 'enum.settlement_statuses.paid', 50),
  ('carried_forward', 'enum.settlement_statuses.carried_forward', 60);
--> statement-breakpoint

CREATE TABLE public.ledger_accounts (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_pk PRIMARY KEY (code), CONSTRAINT ledger_accounts_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_set_updated_at BEFORE UPDATE ON public.ledger_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ledger_accounts (code, label_key, sort_order) VALUES
  ('customer_receipts', 'enum.ledger_accounts.customer_receipts', 10),
  ('gateway_fees', 'enum.ledger_accounts.gateway_fees', 20),
  ('refunds', 'enum.ledger_accounts.refunds', 30),
  ('partner_payable', 'enum.ledger_accounts.partner_payable', 40),
  ('platform_revenue', 'enum.ledger_accounts.platform_revenue', 50),
  ('partner_cash_held', 'enum.ledger_accounts.partner_cash_held', 60),
  ('payouts', 'enum.ledger_accounts.payouts', 70),
  ('adjustments', 'enum.ledger_accounts.adjustments', 80),
  ('credit_liability_transfer', 'enum.ledger_accounts.credit_liability_transfer', 90),
  ('credit_liability_reserve', 'enum.ledger_accounts.credit_liability_reserve', 100),
  ('liability_handover_fund', 'enum.ledger_accounts.liability_handover_fund', 110),
  ('continuity_subsidy', 'enum.ledger_accounts.continuity_subsidy', 120),
  ('ported_credit_revenue', 'enum.ledger_accounts.ported_credit_revenue', 130);
--> statement-breakpoint

CREATE TABLE public.payout_directions (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_directions_pk PRIMARY KEY (code), CONSTRAINT payout_directions_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER payout_directions_set_updated_at BEFORE UPDATE ON public.payout_directions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.payout_directions (code, label_key, sort_order) VALUES
  ('to_partner', 'enum.payout_directions.to_partner', 10),
  ('from_partner', 'enum.payout_directions.from_partner', 20);
--> statement-breakpoint

CREATE TABLE public.payout_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_statuses_pk PRIMARY KEY (code), CONSTRAINT payout_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER payout_statuses_set_updated_at BEFORE UPDATE ON public.payout_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.payout_statuses (code, label_key, sort_order) VALUES
  ('pending', 'enum.payout_statuses.pending', 10),
  ('sent', 'enum.payout_statuses.sent', 20),
  ('confirmed', 'enum.payout_statuses.confirmed', 30),
  ('failed', 'enum.payout_statuses.failed', 40),
  ('cancelled', 'enum.payout_statuses.cancelled', 50);
--> statement-breakpoint

-- ============================================================================
-- payments (§7.1): GLOBAL with a nullable tenant_id
-- ============================================================================

CREATE TABLE public.payments (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid,
  invoice_id               uuid,
  payer_user_id            uuid          NOT NULL,
  provider_code            text          NOT NULL,
  provider_payment_id      text,
  provider_trx_id          text,
  payer_account_masked     text,
  amount                   numeric(12,2) NOT NULL,
  currency                 char(3)       NOT NULL DEFAULT 'BDT',
  gateway_fee              numeric(12,2) NOT NULL DEFAULT 0,
  net_amount               numeric(12,2) GENERATED ALWAYS AS (amount - gateway_fee) STORED,
  status_code              text          NOT NULL DEFAULT 'initiated',
  failure_code             text,
  failure_detail           text,
  collected_by_agent_id    uuid,  -- FK added with field_agents (0011)
  agent_remittance_id      uuid,  -- FK added with agent_cash_remittances (0011)
  idempotency_key          text          NOT NULL,
  initiated_at             timestamptz   NOT NULL DEFAULT now(),
  succeeded_at             timestamptz,
  ledger_posted_at         timestamptz,
  metadata                 jsonb         NOT NULL DEFAULT '{}',
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT payments_pk PRIMARY KEY (id),
  CONSTRAINT payments_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT payments_tenant_id_invoice_id_fk FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT payments_payer_user_id_fk FOREIGN KEY (payer_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT payments_provider_code_fk FOREIGN KEY (provider_code)
    REFERENCES public.payment_providers (code) ON DELETE RESTRICT,
  CONSTRAINT payments_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.payment_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT payments_invoice_tenant_ck CHECK ((tenant_id IS NULL) = (invoice_id IS NULL)),
  CONSTRAINT payments_amount_ck CHECK (amount > 0),
  CONSTRAINT payments_gateway_fee_ck CHECK (gateway_fee >= 0),
  CONSTRAINT payments_agent_remittance_ck CHECK (agent_remittance_id IS NULL OR provider_code = 'cash_agent'),
  CONSTRAINT payments_agent_tenant_ck CHECK (tenant_id IS NOT NULL OR collected_by_agent_id IS NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT payments_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payments_provider_trx_uq ON public.payments (provider_code, provider_trx_id)
  WHERE provider_trx_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX payments_idempotency_key_uq ON public.payments (idempotency_key);
--> statement-breakpoint
-- "My payments" across every tenant.
CREATE INDEX payments_payer_id_idx ON public.payments (payer_user_id, id DESC);
--> statement-breakpoint
-- Settlement aggregation and tenant revenue reports.
CREATE INDEX payments_tenant_succeeded_idx ON public.payments (tenant_id, succeeded_at)
  WHERE status_code IN ('succeeded', 'refunded', 'partially_refunded');
--> statement-breakpoint
-- Cross-tenant system job: poll the gateway for stuck payments.
CREATE INDEX payments_stuck_idx ON public.payments (status_code, initiated_at)
  WHERE status_code IN ('initiated', 'pending');
--> statement-breakpoint
-- Invoice -> payments; also the tenant_id index.
CREATE INDEX payments_tenant_invoice_idx ON public.payments (tenant_id, invoice_id);
--> statement-breakpoint
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- payment_events (§7.2): GLOBAL, system-only
-- ============================================================================

CREATE TABLE public.payment_events (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  payment_id            uuid,
  provider_code         text        NOT NULL,
  provider_event_id     text,
  direction_code        text        NOT NULL,
  event_type            text        NOT NULL,
  http_status           integer,
  signature_valid       boolean,
  payload               jsonb       NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  processed_at          timestamptz,
  processing_error      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_pk PRIMARY KEY (id),
  CONSTRAINT payment_events_payment_id_fk FOREIGN KEY (payment_id)
    REFERENCES public.payments (id) ON DELETE RESTRICT,
  CONSTRAINT payment_events_provider_code_fk FOREIGN KEY (provider_code)
    REFERENCES public.payment_providers (code) ON DELETE RESTRICT,
  CONSTRAINT payment_events_direction_code_fk FOREIGN KEY (direction_code)
    REFERENCES public.payment_event_directions (code) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_events_provider_event_uq ON public.payment_events (provider_code, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX payment_events_payment_id_idx ON public.payment_events (payment_id, received_at);
--> statement-breakpoint
-- Retry sweeper for unprocessed inbound webhooks.
CREATE INDEX payment_events_retry_idx ON public.payment_events (received_at)
  WHERE processed_at IS NULL AND direction_code = 'inbound_webhook';
--> statement-breakpoint
CREATE TRIGGER payment_events_set_updated_at BEFORE UPDATE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- refunds (§7.3): GLOBAL
-- ============================================================================

CREATE TABLE public.refunds (
  id                             uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  payment_id                     uuid          NOT NULL,
  amount                         numeric(12,2) NOT NULL,
  reason_code                    text          NOT NULL,
  status_code                    text          NOT NULL DEFAULT 'requested',
  refund_channel_code            text          NOT NULL DEFAULT 'original_method',
  payout_destination_masked      text,
  destination_verified_at        timestamptz,
  due_by                         timestamptz   NOT NULL,
  reserve_funded_bdt             numeric(12,2) NOT NULL DEFAULT 0,
  platform_share_returned_bdt    numeric(12,2) NOT NULL DEFAULT 0,
  gateway_fee_absorbed_bdt       numeric(12,2) NOT NULL DEFAULT 0,
  provider_refund_id             text,
  requested_by_user_id           uuid          NOT NULL,
  approved_by_user_id            uuid,
  approved_at                    timestamptz,
  succeeded_at                   timestamptz,
  note                           text,
  idempotency_key                text          NOT NULL,
  created_at                     timestamptz   NOT NULL DEFAULT now(),
  updated_at                     timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT refunds_pk PRIMARY KEY (id),
  CONSTRAINT refunds_payment_id_fk FOREIGN KEY (payment_id)
    REFERENCES public.payments (id) ON DELETE RESTRICT,
  CONSTRAINT refunds_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.refund_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT refunds_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.refund_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT refunds_channel_code_fk FOREIGN KEY (refund_channel_code)
    REFERENCES public.refund_channels (code) ON DELETE RESTRICT,
  CONSTRAINT refunds_requested_by_user_id_fk FOREIGN KEY (requested_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT refunds_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT refunds_amount_ck CHECK (amount > 0),
  CONSTRAINT refunds_destination_masked_ck
    CHECK ((refund_channel_code = 'verified_manual_payout') = (payout_destination_masked IS NOT NULL)),
  CONSTRAINT refunds_destination_verified_ck CHECK (
    refund_channel_code <> 'verified_manual_payout'
    OR status_code NOT IN ('processing', 'succeeded')
    OR destination_verified_at IS NOT NULL
  ),
  CONSTRAINT refunds_platform_share_returned_ck CHECK (
    reason_code <> 'tenant_closure_credit_refund'
    OR reserve_funded_bdt + platform_share_returned_bdt = amount
  ),
  CONSTRAINT refunds_gateway_fee_absorbed_ck CHECK (gateway_fee_absorbed_bdt >= 0),
  -- "Nobody approves their own refund request" — a same-row rule, so a plain
  -- CHECK does the job of the spec's stated trigger.
  CONSTRAINT refunds_not_self_approved_ck CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX refunds_idempotency_key_uq ON public.refunds (idempotency_key);
--> statement-breakpoint
CREATE INDEX refunds_payment_id_idx ON public.refunds (payment_id);
--> statement-breakpoint
-- Platform refund queue.
CREATE INDEX refunds_queue_idx ON public.refunds (status_code, id DESC)
  WHERE status_code IN ('requested', 'approved', 'processing');
--> statement-breakpoint
-- SLA breach alerts.
CREATE INDEX refunds_due_by_idx ON public.refunds (due_by)
  WHERE status_code IN ('approved', 'processing');
--> statement-breakpoint
CREATE TRIGGER refunds_set_updated_at BEFORE UPDATE ON public.refunds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- revenue_share_schemes (§7.4) / revenue_share_slabs (§7.5): GLOBAL
-- ============================================================================

CREATE TABLE public.revenue_share_schemes (
  id                         uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  code                       text        NOT NULL,
  name                       text        NOT NULL,
  calculation_method_code    text        NOT NULL DEFAULT 'tiered_marginal',
  basis_code                 text        NOT NULL DEFAULT 'net_of_vat_fees_and_refunds',
  is_default                 boolean     NOT NULL DEFAULT false,
  effective_from             date        NOT NULL,
  effective_to               date,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_share_schemes_pk PRIMARY KEY (id),
  CONSTRAINT revenue_share_schemes_calc_method_code_fk FOREIGN KEY (calculation_method_code)
    REFERENCES public.revenue_calc_methods (code) ON DELETE RESTRICT,
  CONSTRAINT revenue_share_schemes_basis_code_fk FOREIGN KEY (basis_code)
    REFERENCES public.revenue_bases (code) ON DELETE RESTRICT,
  CONSTRAINT revenue_share_schemes_effective_to_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT revenue_share_schemes_code_uq UNIQUE (code),
  -- Never two default schemes on the same day.
  CONSTRAINT revenue_share_schemes_default_excl EXCLUDE USING gist (
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (is_default)
);
--> statement-breakpoint
CREATE TRIGGER revenue_share_schemes_set_updated_at BEFORE UPDATE ON public.revenue_share_schemes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.revenue_share_slabs (
  id                     uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  scheme_id              uuid          NOT NULL,
  revenue_stream_code    text,
  lower_bound            numeric(12,2) NOT NULL,
  upper_bound            numeric(12,2),
  partner_share_pct      numeric(5,2)  NOT NULL,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT revenue_share_slabs_pk PRIMARY KEY (id),
  CONSTRAINT revenue_share_slabs_scheme_id_fk FOREIGN KEY (scheme_id)
    REFERENCES public.revenue_share_schemes (id) ON DELETE RESTRICT,
  CONSTRAINT revenue_share_slabs_revenue_stream_code_fk FOREIGN KEY (revenue_stream_code)
    REFERENCES public.revenue_streams (code) ON DELETE RESTRICT,
  CONSTRAINT revenue_share_slabs_lower_bound_ck CHECK (lower_bound >= 0),
  CONSTRAINT revenue_share_slabs_upper_bound_ck CHECK (upper_bound IS NULL OR upper_bound > lower_bound),
  CONSTRAINT revenue_share_slabs_partner_share_pct_ck CHECK (partner_share_pct BETWEEN 0 AND 100),
  -- Slabs within a scheme+stream never overlap; coalesce needed since NULL
  -- revenue_stream_code (applies to all streams) is never "equal" otherwise.
  CONSTRAINT revenue_share_slabs_no_overlap_excl EXCLUDE USING gist (
    scheme_id WITH =,
    coalesce(revenue_stream_code, '*') WITH =,
    numrange(lower_bound, upper_bound, '[)') WITH &&
  )
);
--> statement-breakpoint
-- Slab lookup during settlement.
CREATE INDEX revenue_share_slabs_lookup_idx ON public.revenue_share_slabs (scheme_id, revenue_stream_code, lower_bound);
--> statement-breakpoint
CREATE TRIGGER revenue_share_slabs_set_updated_at BEFORE UPDATE ON public.revenue_share_slabs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenant_revenue_overrides (§7.6): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.tenant_revenue_overrides (
  id                          uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid          NOT NULL DEFAULT public.current_tenant_id(),
  revenue_stream_code         text,
  scheme_id                   uuid,
  flat_partner_share_pct      numeric(5,2),
  effective_from              date          NOT NULL,
  effective_to                date,
  reason                      text          NOT NULL,
  approved_by_user_id         uuid          NOT NULL,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tenant_revenue_overrides_pk PRIMARY KEY (id),
  CONSTRAINT tenant_revenue_overrides_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_revenue_overrides_revenue_stream_code_fk FOREIGN KEY (revenue_stream_code)
    REFERENCES public.revenue_streams (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_revenue_overrides_scheme_id_fk FOREIGN KEY (scheme_id)
    REFERENCES public.revenue_share_schemes (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_revenue_overrides_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_revenue_overrides_flat_pct_ck CHECK (flat_partner_share_pct IS NULL OR flat_partner_share_pct BETWEEN 0 AND 100),
  CONSTRAINT tenant_revenue_overrides_effective_to_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT tenant_revenue_overrides_target_ck CHECK (num_nonnulls(scheme_id, flat_partner_share_pct) = 1),
  -- At most one override per tenant+stream per day.
  CONSTRAINT tenant_revenue_overrides_no_overlap_excl EXCLUDE USING gist (
    tenant_id WITH =,
    coalesce(revenue_stream_code, '*') WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
--> statement-breakpoint
CREATE TRIGGER tenant_revenue_overrides_set_updated_at BEFORE UPDATE ON public.tenant_revenue_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- settlement_periods (§7.7): GLOBAL
-- ============================================================================

CREATE TABLE public.settlement_periods (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  period_start           date        NOT NULL,
  period_end             date        NOT NULL,
  status_code            text        NOT NULL DEFAULT 'open',
  closed_at              timestamptz,
  approved_by_user_id    uuid,
  approved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_periods_pk PRIMARY KEY (id),
  CONSTRAINT settlement_periods_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.settlement_period_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT settlement_periods_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT settlement_periods_period_end_ck CHECK (period_end >= period_start),
  CONSTRAINT settlement_periods_period_start_uq UNIQUE (period_start),
  -- Periods never overlap.
  CONSTRAINT settlement_periods_no_overlap_excl EXCLUDE USING gist (
    daterange(period_start, period_end, '[]') WITH &&
  )
);
--> statement-breakpoint
CREATE TRIGGER settlement_periods_set_updated_at BEFORE UPDATE ON public.settlement_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- settlements (§7.8): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.settlements (
  id                        uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                 uuid          NOT NULL DEFAULT public.current_tenant_id(),
  settlement_period_id      uuid          NOT NULL,
  partner_id                uuid          NOT NULL,
  status_code               text          NOT NULL DEFAULT 'draft',
  gross_revenue             numeric(12,2) NOT NULL DEFAULT 0,
  gateway_fees              numeric(12,2) NOT NULL DEFAULT 0,
  refunds_total             numeric(12,2) NOT NULL DEFAULT 0,
  revenue_basis             numeric(12,2) NOT NULL DEFAULT 0,
  ported_credit_revenue     numeric(12,2) NOT NULL DEFAULT 0,
  partner_share             numeric(12,2) NOT NULL DEFAULT 0,
  platform_share            numeric(12,2) NOT NULL DEFAULT 0,
  cash_held_by_partner      numeric(12,2) NOT NULL DEFAULT 0,
  adjustments_total         numeric(12,2) NOT NULL DEFAULT 0,
  carried_forward_in        numeric(12,2) NOT NULL DEFAULT 0,
  net_payable               numeric(12,2) NOT NULL DEFAULT 0,
  calculation_snapshot      jsonb         NOT NULL DEFAULT '{}',
  calculated_at             timestamptz,
  approved_by_user_id       uuid,
  approved_at               timestamptz,
  dispute_note              text,
  disputed_at               timestamptz,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT settlements_pk PRIMARY KEY (id),
  CONSTRAINT settlements_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT settlements_settlement_period_id_fk FOREIGN KEY (settlement_period_id)
    REFERENCES public.settlement_periods (id) ON DELETE RESTRICT,
  CONSTRAINT settlements_partner_id_fk FOREIGN KEY (partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT settlements_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.settlement_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT settlements_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT settlements_ported_credit_revenue_ck CHECK (ported_credit_revenue >= 0),
  CONSTRAINT settlements_share_split_ck CHECK (partner_share + platform_share = revenue_basis),
  CONSTRAINT settlements_net_payable_ck CHECK (
    net_payable = partner_share + ported_credit_revenue - cash_held_by_partner + adjustments_total + carried_forward_in
  ),
  CONSTRAINT settlements_calculation_snapshot_ck CHECK (jsonb_typeof(calculation_snapshot) = 'object'),
  CONSTRAINT settlements_tenant_period_partner_uq UNIQUE (tenant_id, settlement_period_id, partner_id),
  -- Composite-FK target (§0.4).
  CONSTRAINT settlements_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Cross-tenant platform payout run.
CREATE INDEX settlements_period_status_idx ON public.settlements (settlement_period_id, status_code);
--> statement-breakpoint
CREATE TRIGGER settlements_set_updated_at BEFORE UPDATE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A settlement becomes immutable once approved; corrections are adjustment
-- entries in a later period, not edits to an approved statement.
CREATE OR REPLACE FUNCTION public.settlements_prevent_mutation_after_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'settlements: an approved settlement cannot be deleted (id %)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'settlements: cannot modify an approved settlement (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER settlements_a_prevent_mutation_after_approval BEFORE UPDATE OR DELETE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.settlements_prevent_mutation_after_approval();
--> statement-breakpoint

-- ============================================================================
-- payouts (§7.10): TENANT-SCOPED — created before settlement_ledger_entries
-- so the latter's composite FK to it can be a real constraint, not deferred.
-- ============================================================================

CREATE TABLE public.payouts (
  id                              uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                       uuid          NOT NULL DEFAULT public.current_tenant_id(),
  settlement_id                   uuid          NOT NULL,
  direction_code                  text          NOT NULL DEFAULT 'to_partner',
  partner_payout_account_id       uuid,
  account_snapshot                jsonb         NOT NULL DEFAULT '{}',
  amount                          numeric(12,2) NOT NULL,
  withholding_vat_bdt             numeric(12,2) NOT NULL DEFAULT 0,
  withholding_tax_bdt             numeric(12,2) NOT NULL DEFAULT 0,
  withholding_certificate_key     text,
  method_code                     text          NOT NULL,
  status_code                     text          NOT NULL DEFAULT 'pending',
  external_reference              text,
  sent_at                         timestamptz,
  confirmed_at                    timestamptz,
  initiated_by_user_id            uuid          NOT NULL,
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT payouts_pk PRIMARY KEY (id),
  CONSTRAINT payouts_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT payouts_tenant_id_settlement_id_fk FOREIGN KEY (tenant_id, settlement_id)
    REFERENCES public.settlements (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT payouts_direction_code_fk FOREIGN KEY (direction_code)
    REFERENCES public.payout_directions (code) ON DELETE RESTRICT,
  CONSTRAINT payouts_partner_payout_account_id_fk FOREIGN KEY (partner_payout_account_id)
    REFERENCES public.partner_payout_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT payouts_method_code_fk FOREIGN KEY (method_code)
    REFERENCES public.payout_methods (code) ON DELETE RESTRICT,
  CONSTRAINT payouts_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.payout_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT payouts_initiated_by_user_id_fk FOREIGN KEY (initiated_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT payouts_account_snapshot_ck CHECK (jsonb_typeof(account_snapshot) = 'object'),
  CONSTRAINT payouts_amount_ck CHECK (amount > 0),
  CONSTRAINT payouts_withholding_vat_ck CHECK (withholding_vat_bdt >= 0),
  CONSTRAINT payouts_withholding_tax_ck CHECK (withholding_tax_bdt >= 0),
  CONSTRAINT payouts_partner_account_required_ck
    CHECK (direction_code <> 'to_partner' OR partner_payout_account_id IS NOT NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT payouts_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Statement -> payouts; also the tenant_id index.
CREATE INDEX payouts_tenant_settlement_idx ON public.payouts (tenant_id, settlement_id);
--> statement-breakpoint
-- Cross-tenant finance worklist.
CREATE INDEX payouts_worklist_idx ON public.payouts (status_code, id)
  WHERE status_code IN ('pending', 'sent');
--> statement-breakpoint
CREATE UNIQUE INDEX payouts_method_external_ref_uq ON public.payouts (method_code, external_reference)
  WHERE external_reference IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER payouts_set_updated_at BEFORE UPDATE ON public.payouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- settlement_ledger_entries (§7.9): TENANT-SCOPED, immutable double-entry
-- journal
-- ============================================================================

CREATE TABLE public.settlement_ledger_entries (
  id                     uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id               uuid          NOT NULL DEFAULT public.current_tenant_id(),
  journal_id              uuid          NOT NULL,
  partner_id              uuid          NOT NULL,
  account_code            text          NOT NULL,
  amount                  numeric(12,2) NOT NULL,
  revenue_stream_code     text,
  occurred_at             timestamptz   NOT NULL,
  settlement_id           uuid,
  payment_id              uuid,
  refund_id               uuid,
  payout_id               uuid,
  memo                    text,
  created_by_user_id      uuid,
  idempotency_key         text          NOT NULL,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT settlement_ledger_entries_pk PRIMARY KEY (id),
  CONSTRAINT settlement_ledger_entries_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_partner_id_fk FOREIGN KEY (partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_account_code_fk FOREIGN KEY (account_code)
    REFERENCES public.ledger_accounts (code) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_revenue_stream_code_fk FOREIGN KEY (revenue_stream_code)
    REFERENCES public.revenue_streams (code) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_tenant_id_settlement_id_fk FOREIGN KEY (tenant_id, settlement_id)
    REFERENCES public.settlements (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_tenant_id_payment_id_fk FOREIGN KEY (tenant_id, payment_id)
    REFERENCES public.payments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_refund_id_fk FOREIGN KEY (refund_id)
    REFERENCES public.refunds (id) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_tenant_id_payout_id_fk FOREIGN KEY (tenant_id, payout_id)
    REFERENCES public.payouts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT settlement_ledger_entries_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT settlement_ledger_entries_amount_ck CHECK (amount <> 0),
  CONSTRAINT settlement_ledger_entries_memo_required_ck CHECK (account_code <> 'adjustments' OR memo IS NOT NULL),
  CONSTRAINT settlement_ledger_entries_idempotency_uq UNIQUE (tenant_id, idempotency_key, account_code)
);
--> statement-breakpoint
-- Period close picks up unsettled entries per partner; also the tenant_id index.
CREATE INDEX settlement_ledger_entries_unsettled_idx ON public.settlement_ledger_entries (tenant_id, partner_id, occurred_at)
  WHERE settlement_id IS NULL;
--> statement-breakpoint
-- Statement breakdown.
CREATE INDEX settlement_ledger_entries_settlement_idx ON public.settlement_ledger_entries (tenant_id, settlement_id, account_code);
--> statement-breakpoint
-- Balance check, drill-down.
CREATE INDEX settlement_ledger_entries_journal_idx ON public.settlement_ledger_entries (journal_id);
--> statement-breakpoint
CREATE TRIGGER settlement_ledger_entries_set_updated_at BEFORE UPDATE ON public.settlement_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Every journal balances: deferred so every leg of a multi-row journal can
-- be inserted first, checked once as a whole at commit.
CREATE OR REPLACE FUNCTION public.settlement_ledger_entries_check_journal_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total numeric(12,2);
BEGIN
  SELECT coalesce(sum(amount), 0) INTO total
  FROM public.settlement_ledger_entries
  WHERE journal_id = NEW.journal_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'settlement_ledger_entries: journal % does not balance (sum = %)', NEW.journal_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER settlement_ledger_entries_a_balance_check
  AFTER INSERT ON public.settlement_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.settlement_ledger_entries_check_journal_balance();
--> statement-breakpoint

-- A leg's settlement_id must belong to the same partner_id.
CREATE OR REPLACE FUNCTION public.settlement_ledger_entries_validate_settlement_partner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  settlement_partner_id uuid;
BEGIN
  IF NEW.settlement_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.partner_id INTO settlement_partner_id
  FROM public.settlements s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.settlement_id;
  IF settlement_partner_id IS DISTINCT FROM NEW.partner_id THEN
    RAISE EXCEPTION 'settlement_ledger_entries: settlement % belongs to a different partner', NEW.settlement_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_ledger_entries_a_validate_settlement_partner
  BEFORE INSERT OR UPDATE OF settlement_id ON public.settlement_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.settlement_ledger_entries_validate_settlement_partner();
--> statement-breakpoint

-- A leg's refund_id must belong to a payment of this same tenant.
CREATE OR REPLACE FUNCTION public.settlement_ledger_entries_validate_refund_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refund_tenant_id uuid;
BEGIN
  IF NEW.refund_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.tenant_id INTO refund_tenant_id
  FROM public.refunds r JOIN public.payments p ON p.id = r.payment_id
  WHERE r.id = NEW.refund_id;
  IF refund_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'settlement_ledger_entries: refund % belongs to a different tenant', NEW.refund_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_ledger_entries_a_validate_refund_tenant
  BEFORE INSERT OR UPDATE OF refund_id ON public.settlement_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.settlement_ledger_entries_validate_refund_tenant();
--> statement-breakpoint

-- Immutable except the one-time stamping of settlement_id; DELETE always blocked.
CREATE OR REPLACE FUNCTION public.settlement_ledger_entries_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_ledger_entries rows are immutable (DELETE blocked)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.settlement_id IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_ledger_entries: settlement_id already stamped (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF row(NEW.id, NEW.tenant_id, NEW.journal_id, NEW.partner_id, NEW.account_code, NEW.amount,
         NEW.revenue_stream_code, NEW.occurred_at, NEW.payment_id, NEW.refund_id, NEW.payout_id,
         NEW.memo, NEW.created_by_user_id, NEW.idempotency_key)
      IS DISTINCT FROM
      row(OLD.id, OLD.tenant_id, OLD.journal_id, OLD.partner_id, OLD.account_code, OLD.amount,
         OLD.revenue_stream_code, OLD.occurred_at, OLD.payment_id, OLD.refund_id, OLD.payout_id,
         OLD.memo, OLD.created_by_user_id, OLD.idempotency_key) THEN
    RAISE EXCEPTION 'settlement_ledger_entries: only settlement_id may change (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_ledger_entries_b_prevent_mutation BEFORE UPDATE OR DELETE ON public.settlement_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.settlement_ledger_entries_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- tenant_final_settlement (§7.11): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.tenant_final_settlement (
  id                              uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                       uuid          NOT NULL DEFAULT public.current_tenant_id(),
  partner_id                      uuid          NOT NULL,
  closure_type_code               text          NOT NULL,
  tenant_transfer_id              uuid,
  incoming_partner_id             uuid,
  cutoff_at                       timestamptz   NOT NULL,
  last_settlement_id              uuid,
  gross_owed                      numeric(12,2) NOT NULL DEFAULT 0,
  total_liability_bdt             numeric(12,2) NOT NULL DEFAULT 0,
  liability_deduction             numeric(12,2) NOT NULL DEFAULT 0,
  platform_share_retained_bdt     numeric(12,2) NOT NULL DEFAULT 0,
  liability_handover_amount       numeric(12,2) NOT NULL DEFAULT 0,
  platform_fronted_amount         numeric(12,2) NOT NULL DEFAULT 0,
  liability_calculation           jsonb         NOT NULL DEFAULT '{}',
  net_payable                     numeric(12,2) NOT NULL DEFAULT 0,
  status_code                     text          NOT NULL DEFAULT 'draft',
  payout_id                       uuid,
  receivable_payout_id            uuid,
  write_off_reason                text,
  liability_journal_id            uuid,
  calculated_at                   timestamptz,
  approved_by_user_id             uuid,
  approved_at                     timestamptz,
  settled_at                      timestamptz,
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tenant_final_settlement_pk PRIMARY KEY (id),
  CONSTRAINT tenant_final_settlement_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_partner_id_fk FOREIGN KEY (partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_incoming_partner_id_fk FOREIGN KEY (incoming_partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_closure_type_code_fk FOREIGN KEY (closure_type_code)
    REFERENCES public.tenant_closure_types (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_tenant_id_transfer_id_fk FOREIGN KEY (tenant_id, tenant_transfer_id)
    REFERENCES public.tenant_transfers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_tenant_id_last_settlement_id_fk FOREIGN KEY (tenant_id, last_settlement_id)
    REFERENCES public.settlements (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_tenant_id_payout_id_fk FOREIGN KEY (tenant_id, payout_id)
    REFERENCES public.payouts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_tenant_id_receivable_payout_id_fk FOREIGN KEY (tenant_id, receivable_payout_id)
    REFERENCES public.payouts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.final_settlement_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_final_settlement_transfer_id_ck CHECK ((closure_type_code = 'transfer') = (tenant_transfer_id IS NOT NULL)),
  CONSTRAINT tenant_final_settlement_incoming_partner_ck CHECK ((closure_type_code = 'transfer') = (incoming_partner_id IS NOT NULL)),
  CONSTRAINT tenant_final_settlement_total_liability_ck CHECK (total_liability_bdt >= 0),
  CONSTRAINT tenant_final_settlement_liability_deduction_ck CHECK (liability_deduction BETWEEN 0 AND total_liability_bdt),
  CONSTRAINT tenant_final_settlement_handover_amount_ck
    CHECK (closure_type_code = 'transfer' OR liability_handover_amount = 0),
  CONSTRAINT tenant_final_settlement_fronted_amount_ck CHECK (platform_fronted_amount >= 0),
  CONSTRAINT tenant_final_settlement_liability_calculation_ck CHECK (jsonb_typeof(liability_calculation) = 'object'),
  CONSTRAINT tenant_final_settlement_receivable_ck CHECK (status_code <> 'receivable_open' OR net_payable < 0),
  CONSTRAINT tenant_final_settlement_write_off_ck
    CHECK (status_code <> 'written_off' OR (write_off_reason IS NOT NULL AND approved_by_user_id IS NOT NULL)),
  CONSTRAINT tenant_final_settlement_cutoff_uq UNIQUE (tenant_id, cutoff_at)
);
--> statement-breakpoint
-- Cross-tenant finance worklist.
CREATE INDEX tenant_final_settlement_worklist_idx ON public.tenant_final_settlement (status_code, id)
  WHERE status_code IN ('draft', 'calculated', 'approved', 'receivable_open');
--> statement-breakpoint
-- Cross-tenant fronted handovers still to chase.
CREATE INDEX tenant_final_settlement_fronted_idx ON public.tenant_final_settlement (id)
  WHERE platform_fronted_amount > 0 AND status_code <> 'receivable_collected';
--> statement-breakpoint
CREATE INDEX tenant_final_settlement_partner_idx ON public.tenant_final_settlement (partner_id);
--> statement-breakpoint
CREATE INDEX tenant_final_settlement_incoming_partner_idx ON public.tenant_final_settlement (incoming_partner_id)
  WHERE incoming_partner_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER tenant_final_settlement_set_updated_at BEFORE UPDATE ON public.tenant_final_settlement
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- platform_share_rate_backfills (§7.12): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.platform_share_rate_backfills (
  id                              uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                       uuid          NOT NULL DEFAULT public.current_tenant_id(),
  settlement_period_id            uuid          NOT NULL,
  credit_basis_bdt                numeric(12,2) NOT NULL,
  ledger_platform_share_bdt       numeric(12,2) NOT NULL,
  blended_rate_exact              numeric       NOT NULL,
  platform_share_rate_final       numeric(9,8)  NOT NULL,
  allocated_platform_share_bdt    numeric(12,2) NOT NULL,
  transactions_updated            integer       NOT NULL,
  true_ups_posted                 integer       NOT NULL DEFAULT 0,
  run_at                          timestamptz   NOT NULL DEFAULT now(),
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT platform_share_rate_backfills_pk PRIMARY KEY (id),
  CONSTRAINT platform_share_rate_backfills_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT platform_share_rate_backfills_settlement_period_id_fk FOREIGN KEY (settlement_period_id)
    REFERENCES public.settlement_periods (id) ON DELETE RESTRICT,
  CONSTRAINT platform_share_rate_backfills_allocated_ck CHECK (allocated_platform_share_bdt = ledger_platform_share_bdt),
  CONSTRAINT platform_share_rate_backfills_tenant_period_uq UNIQUE (tenant_id, settlement_period_id)
);
--> statement-breakpoint
CREATE TRIGGER platform_share_rate_backfills_set_updated_at BEFORE UPDATE ON public.platform_share_rate_backfills
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- Closing six deferred FKs from 0003/0007, now that their targets exist.
-- ============================================================================

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_tax_invoice_format_code_fk
    FOREIGN KEY (tax_invoice_format_code) REFERENCES public.tax_invoice_formats (code) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_tenant_id_payment_id_fk
    FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.credit_lots
  ADD CONSTRAINT credit_lots_tenant_id_payment_id_fk
    FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.platform_credit_pool
  ADD CONSTRAINT platform_credit_pool_payment_id_fk
    FOREIGN KEY (payment_id) REFERENCES public.payments (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.platform_credit_pool
  ADD CONSTRAINT platform_credit_pool_refund_id_fk
    FOREIGN KEY (refund_id) REFERENCES public.refunds (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.tenant_transfers
  ADD CONSTRAINT tenant_transfers_tenant_id_final_settlement_id_fk
    FOREIGN KEY (tenant_id, final_settlement_id) REFERENCES public.settlements (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
-- A transfer's final_settlement_id must exist before it goes effective (§2.13).
ALTER TABLE public.tenant_transfers
  ADD CONSTRAINT tenant_transfers_final_settlement_required_ck
    CHECK (status_code <> 'effective' OR final_settlement_id IS NOT NULL);


-- ============================================================================
-- RLS: enable + force on every table created in this migration
-- ============================================================================

DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT c.oid::regclass AS ident
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'tax_invoice_formats', 'refund_channels', 'tenant_closure_types', 'final_settlement_statuses',
        'payment_providers', 'payment_statuses', 'payment_event_directions', 'refund_reasons', 'refund_statuses',
        'revenue_calc_methods', 'revenue_bases', 'settlement_period_statuses', 'settlement_statuses',
        'ledger_accounts', 'payout_directions', 'payout_statuses',
        'payments', 'payment_events', 'refunds', 'revenue_share_schemes', 'revenue_share_slabs',
        'tenant_revenue_overrides', 'settlement_periods', 'settlements', 'payouts',
        'settlement_ledger_entries', 'tenant_final_settlement', 'platform_share_rate_backfills'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0007) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'tax_invoice_formats', 'refund_channels', 'tenant_closure_types', 'final_settlement_statuses',
    'payment_providers', 'payment_statuses', 'payment_event_directions', 'refund_reasons', 'refund_statuses',
    'revenue_calc_methods', 'revenue_bases', 'settlement_period_statuses', 'settlement_statuses',
    'ledger_accounts', 'payout_directions', 'payout_statuses'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (true)',
      enum_table || '_read_all', enum_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()))',
      enum_table || '_platform_admin', enum_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- payments: custom (§7.1) ----------------------------------------------

CREATE POLICY payments_payer_read ON public.payments
  FOR SELECT USING (payer_user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY payments_tenant_admin_read ON public.payments
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY payments_platform_read ON public.payments
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY payments_self_insert ON public.payments
  FOR INSERT
  WITH CHECK (
    payer_user_id = (SELECT public.current_user_id())
    AND tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_active_user())
  );
--> statement-breakpoint
-- Staff-recorded cash/bank payments in their tenant. Narrowing this further
-- to the field-agent role specifically waits on field_agents (0011).
CREATE POLICY payments_staff_insert ON public.payments
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND provider_code IN ('cash_agent', 'bank_transfer')
    AND (SELECT public.app_is_staff())
  );
--> statement-breakpoint
CREATE POLICY payments_platform_level_insert ON public.payments
  FOR INSERT
  WITH CHECK (
    tenant_id IS NULL
    AND ((SELECT public.app_role()) IN ('platform_admin', 'platform_finance') OR (SELECT public.app_is_system()))
  );
--> statement-breakpoint
CREATE POLICY payments_system_write ON public.payments
  FOR UPDATE
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY payments_tenant_admin_confirm ON public.payments
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_tenant_admin())
    AND provider_code IN ('cash_agent', 'bank_transfer')
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_tenant_admin())
    AND provider_code IN ('cash_agent', 'bank_transfer')
  );
--> statement-breakpoint

-- ---- payment_events: system-only (§7.2) -----------------------------------

CREATE POLICY payment_events_system_only ON public.payment_events
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- refunds: visibility follows payments' own RLS (§7.3) ----------------

CREATE POLICY refunds_visible_via_payment ON public.refunds
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = refunds.payment_id));
--> statement-breakpoint
CREATE POLICY refunds_tenant_admin_insert ON public.refunds
  FOR INSERT
  WITH CHECK (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.id = refunds.payment_id AND p.tenant_id = (SELECT public.current_tenant_id())
    )
  );
--> statement-breakpoint
CREATE POLICY refunds_platform_insert ON public.refunds
  FOR INSERT
  WITH CHECK ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
-- The exact approval-routing threshold (tenant_admin up to
-- tenant_refund_approval_limit_bdt, original_method only; platform above
-- that and for every verified_manual_payout) is service-enforced (reads
-- SettingsService, see header) — RLS only backstops "your tenant's refunds".
CREATE POLICY refunds_tenant_admin_update ON public.refunds
  FOR UPDATE
  USING (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.id = refunds.payment_id AND p.tenant_id = (SELECT public.current_tenant_id())
    )
  )
  WITH CHECK (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.id = refunds.payment_id AND p.tenant_id = (SELECT public.current_tenant_id())
    )
  );
--> statement-breakpoint
CREATE POLICY refunds_platform_write ON public.refunds
  FOR ALL
  USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- revenue_share_schemes / revenue_share_slabs (§7.4-7.5) --------------

CREATE POLICY revenue_share_schemes_tenant_admin_read ON public.revenue_share_schemes
  FOR SELECT USING ((SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY revenue_share_schemes_platform_read ON public.revenue_share_schemes
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY revenue_share_schemes_platform_write ON public.revenue_share_schemes
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY revenue_share_slabs_tenant_admin_read ON public.revenue_share_slabs
  FOR SELECT USING ((SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY revenue_share_slabs_platform_read ON public.revenue_share_slabs
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY revenue_share_slabs_platform_write ON public.revenue_share_slabs
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- tenant_revenue_overrides: T-ISOLATE read; platform-only write (§7.6) -

CREATE POLICY tenant_revenue_overrides_tenant_admin_read ON public.tenant_revenue_overrides
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_revenue_overrides_platform_write ON public.tenant_revenue_overrides
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- settlement_periods: G-REFERENCE-like read; platform/system write (§7.7)

CREATE POLICY settlement_periods_tenant_admin_read ON public.settlement_periods
  FOR SELECT USING ((SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY settlement_periods_platform_read ON public.settlement_periods
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY settlement_periods_platform_write ON public.settlement_periods
  FOR ALL
  USING ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- settlements: T-ISOLATE read; dispute by tenant_admin; rest platform (§7.8)

CREATE POLICY settlements_tenant_read ON public.settlements
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
-- Column-level narrowing to dispute_note/disputed_at is service-enforced,
-- same caveat as 0007's subscriptions_subscriber_cancel.
CREATE POLICY settlements_tenant_dispute ON public.settlements
  FOR UPDATE
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY settlements_platform_access ON public.settlements
  FOR ALL
  USING ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- payouts: T-ISOLATE read; platform_finance/platform_admin write (§7.10)

CREATE POLICY payouts_tenant_read ON public.payouts
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY payouts_platform_write ON public.payouts
  FOR ALL
  USING ((SELECT public.app_role()) = 'platform_finance' OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_role()) = 'platform_finance' OR (SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- settlement_ledger_entries: T-ISOLATE read; platform/system write (§7.9)

CREATE POLICY settlement_ledger_entries_tenant_read ON public.settlement_ledger_entries
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY settlement_ledger_entries_platform_write ON public.settlement_ledger_entries
  FOR ALL
  USING ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- tenant_final_settlement: T-ISOLATE read; system calc, platform approve (§7.11)

CREATE POLICY tenant_final_settlement_tenant_read ON public.tenant_final_settlement
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_final_settlement_platform_read ON public.tenant_final_settlement
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY tenant_final_settlement_system_write ON public.tenant_final_settlement
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY tenant_final_settlement_platform_write ON public.tenant_final_settlement
  FOR ALL
  USING ((SELECT public.app_role()) IN ('platform_finance', 'platform_admin') OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_role()) IN ('platform_finance', 'platform_admin') OR (SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- platform_share_rate_backfills: T-ISOLATE read; system write (§7.12) -

CREATE POLICY platform_share_rate_backfills_tenant_read ON public.platform_share_rate_backfills
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY platform_share_rate_backfills_platform_read ON public.platform_share_rate_backfills
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY platform_share_rate_backfills_system_write ON public.platform_share_rate_backfills
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));


-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.tax_invoice_formats, public.refund_channels, public.tenant_closure_types, public.final_settlement_statuses,
  public.payment_providers, public.payment_statuses, public.payment_event_directions, public.refund_reasons,
  public.refund_statuses, public.revenue_calc_methods, public.revenue_bases, public.settlement_period_statuses,
  public.settlement_statuses, public.ledger_accounts, public.payout_directions, public.payout_statuses
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.tax_invoice_formats, public.refund_channels, public.tenant_closure_types, public.final_settlement_statuses,
  public.payment_providers, public.payment_statuses, public.payment_event_directions, public.refund_reasons,
  public.refund_statuses, public.revenue_calc_methods, public.revenue_bases, public.settlement_period_statuses,
  public.settlement_statuses, public.ledger_accounts, public.payout_directions, public.payout_statuses
TO ae_app;
--> statement-breakpoint

-- No DELETE: permanent retention (§13.30).
GRANT SELECT, INSERT, UPDATE ON public.payments TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.payment_events TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.refunds TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.revenue_share_schemes TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.revenue_share_slabs TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_revenue_overrides TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.settlement_periods TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.settlements TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.payouts TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.settlement_ledger_entries TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_final_settlement TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.platform_share_rate_backfills TO ae_app;

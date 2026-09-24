-- 0007_commerce
--
-- Commerce domain (docs/specs/schema.md §6): credit wallets/ledger/lots,
-- credit packages, boosts, subscriptions, invoices, ads, and the full
-- tenant-closure credit economics (porting, pooling, liability settlement).
-- This is the largest and most consequential domain in the spec — the ADRs
-- it implements (004, 007-014) were the most deliberated part of the whole
-- design. Runs as ae_migrator; RLS and grants are in this same file.
--
-- Closes three deferred FKs now that their target enums exist:
--   - tenant_transfers.credit_valuation_method_code -> credit_valuation_methods (0003)
--   - vat_rates.revenue_stream_code -> revenue_streams (0003)
--   - stores.current_plan_code -> subscription_plans(code) (0006)
--
-- ============================================================================
-- SCOPE — read this before the SQL. CLAUDE.md's current phase is schema,
-- migrations and RLS, not application features; this migration draws that
-- line as follows.
-- ============================================================================
--
-- Built here (all tables, every declarative CHECK/FK/index spec lists, and
-- every trigger that is genuinely self-contained):
--   - Every table's full DDL, including the closure/porting/settlement
--     tables (tenant_credit_liability, platform_credit_pool,
--     credit_closure_dispositions, credit_liability_settlements) — their
--     SHAPE is schema; nothing here fabricates data in them.
--   - Price/cost-bound triggers (Q7) on the four *_prices/*_inventory
--     tables: a tenant override can't leave the global min/max band.
--   - Structural CHECKs exactly as spec states them (num_nonnulls, sign,
--     range, "X iff Y" pairs).
--   - EXCLUDE constraints for boosts and ad_bookings (no double-booking).
--   - Append-only immutability triggers (credit_transactions,
--     credit_lot_allocations, credit_liability_settlements except the
--     one-time true-up columns).
--   - credit_wallets' "starts at zero" guard and its balance/newest-
--     transaction consistency guard (structural safety nets, not the mutator).
--   - invoices: locked after issued_at; invoice_lines keep the parent's
--     subtotal/tax_total/total in sync and are immutable after issue.
--   - can_view_invoice(): plain (not SECURITY DEFINER, see 0006's
--     can_manage_store() precedent), used by invoice_lines' RLS only —
--     no self-reference, so no recursion risk.
--
-- Explicitly NOT built here — each is a substantial, standalone piece of
-- orchestration logic (locking protocol, FIFO/expiry-ordered allocation,
-- cross-tenant ledger postings, subsidy-cap advisory locks) that deserves
-- its own dedicated design-and-test pass, not a rushed subroutine of an
-- already-large migration:
--   - credit_apply(): the single mutation entrypoint (§6.2's "Mutation
--     protocol"). Nothing currently writes credit_transactions/credit_lots
--     through it; the tables and their structural guards exist and wait for
--     it. This is the single most important follow-up task for this domain.
--   - The SECURITY DEFINER triggers on credit_lots that sync
--     tenant_credit_liability and credit_wallets.ported_balance (§6.20).
--   - The SECURITY DEFINER trigger on credit_lot_allocations that writes
--     credit_liability_settlements with the subsidy-cap advisory locks (§6.23).
--   - Tenant-closure orchestration: creating credit_closure_dispositions,
--     parking lots into platform_credit_pool, the auto-restore job/event
--     hooks, request_closure_refund().
--   - live_ads(slot, category): the ad-serving read path.
--   - Boost lifecycle automation: activating/expiring/stopping boosts and
--     issuing boost_vouchers on early-stop. boosts.status_code changes are
--     plain columns an authorized writer can set directly for now.
--   - The one-time platform_share_rate_final/_bdt_final month-close back-
--     fill exception to credit_transactions' immutability (§7.12 territory).
--
-- Practical effect: these tables can be migrated, RLS-tested and mirrored
-- today, but nothing in the running API can move a credit yet. That is
-- intentional — Week 1 is schema, not the ledger engine.

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.credit_reasons (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_reasons_pk PRIMARY KEY (code), CONSTRAINT credit_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER credit_reasons_set_updated_at BEFORE UPDATE ON public.credit_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.credit_reasons (code, label_key, sort_order) VALUES
  ('purchase', 'enum.credit_reasons.purchase', 10),
  ('plan_grant', 'enum.credit_reasons.plan_grant', 20),
  ('promo_grant', 'enum.credit_reasons.promo_grant', 30),
  ('referral_bonus', 'enum.credit_reasons.referral_bonus', 40),
  ('post_fee', 'enum.credit_reasons.post_fee', 50),
  ('boost', 'enum.credit_reasons.boost', 60),
  ('refund_clawback', 'enum.credit_reasons.refund_clawback', 70),
  ('admin_adjustment', 'enum.credit_reasons.admin_adjustment', 80),
  ('reversal', 'enum.credit_reasons.reversal', 90),
  ('expiry', 'enum.credit_reasons.expiry', 100),
  ('tenant_closure_transfer_out', 'enum.credit_reasons.tenant_closure_transfer_out', 110),
  ('tenant_closure_transfer_in', 'enum.credit_reasons.tenant_closure_transfer_in', 120),
  ('platform_pool_park', 'enum.credit_reasons.platform_pool_park', 130),
  ('platform_pool_restore', 'enum.credit_reasons.platform_pool_restore', 140),
  ('closure_cash_refund', 'enum.credit_reasons.closure_cash_refund', 150);
--> statement-breakpoint

CREATE TABLE public.credit_valuation_methods (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_valuation_methods_pk PRIMARY KEY (code), CONSTRAINT credit_valuation_methods_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER credit_valuation_methods_set_updated_at BEFORE UPDATE ON public.credit_valuation_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.credit_valuation_methods (code, label_key, sort_order) VALUES
  ('original_purchase_price', 'enum.credit_valuation_methods.original_purchase_price', 10),
  ('negotiated', 'enum.credit_valuation_methods.negotiated', 20);
--> statement-breakpoint

CREATE TABLE public.credit_pool_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_pool_statuses_pk PRIMARY KEY (code), CONSTRAINT credit_pool_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER credit_pool_statuses_set_updated_at BEFORE UPDATE ON public.credit_pool_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.credit_pool_statuses (code, label_key, sort_order) VALUES
  ('held', 'enum.credit_pool_statuses.held', 10),
  ('restored', 'enum.credit_pool_statuses.restored', 20),
  ('refunded', 'enum.credit_pool_statuses.refunded', 30);
--> statement-breakpoint

CREATE TABLE public.credit_disposition_outcomes (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_disposition_outcomes_pk PRIMARY KEY (code), CONSTRAINT credit_disposition_outcomes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER credit_disposition_outcomes_set_updated_at BEFORE UPDATE ON public.credit_disposition_outcomes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.credit_disposition_outcomes (code, label_key, sort_order) VALUES
  ('ported', 'enum.credit_disposition_outcomes.ported', 10),
  ('pooled', 'enum.credit_disposition_outcomes.pooled', 20);
--> statement-breakpoint

CREATE TABLE public.port_destination_rules (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT port_destination_rules_pk PRIMARY KEY (code), CONSTRAINT port_destination_rules_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER port_destination_rules_set_updated_at BEFORE UPDATE ON public.port_destination_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.port_destination_rules (code, label_key, sort_order) VALUES
  ('recent_activity', 'enum.port_destination_rules.recent_activity', 10),
  ('nearest_existing_membership', 'enum.port_destination_rules.nearest_existing_membership', 20);
--> statement-breakpoint

CREATE TABLE public.closure_refund_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closure_refund_statuses_pk PRIMARY KEY (code), CONSTRAINT closure_refund_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER closure_refund_statuses_set_updated_at BEFORE UPDATE ON public.closure_refund_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.closure_refund_statuses (code, label_key, sort_order) VALUES
  ('not_requested', 'enum.closure_refund_statuses.not_requested', 10),
  ('requested', 'enum.closure_refund_statuses.requested', 20),
  ('paid', 'enum.closure_refund_statuses.paid', 30),
  ('rejected', 'enum.closure_refund_statuses.rejected', 40),
  ('window_expired', 'enum.closure_refund_statuses.window_expired', 50);
--> statement-breakpoint

CREATE TABLE public.liability_settlement_kinds (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT liability_settlement_kinds_pk PRIMARY KEY (code), CONSTRAINT liability_settlement_kinds_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER liability_settlement_kinds_set_updated_at BEFORE UPDATE ON public.liability_settlement_kinds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.liability_settlement_kinds (code, label_key, sort_order) VALUES
  ('closure_port', 'enum.liability_settlement_kinds.closure_port', 10),
  ('pool_restore', 'enum.liability_settlement_kinds.pool_restore', 20),
  ('partner_transfer', 'enum.liability_settlement_kinds.partner_transfer', 30);
--> statement-breakpoint

CREATE TABLE public.boost_placements (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boost_placements_pk PRIMARY KEY (code), CONSTRAINT boost_placements_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER boost_placements_set_updated_at BEFORE UPDATE ON public.boost_placements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.boost_placements (code, label_key, sort_order) VALUES
  ('category_top', 'enum.boost_placements.category_top', 10),
  ('home_featured', 'enum.boost_placements.home_featured', 20),
  ('highlight', 'enum.boost_placements.highlight', 30),
  ('bump', 'enum.boost_placements.bump', 40);
--> statement-breakpoint

CREATE TABLE public.boost_targets (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boost_targets_pk PRIMARY KEY (code), CONSTRAINT boost_targets_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER boost_targets_set_updated_at BEFORE UPDATE ON public.boost_targets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.boost_targets (code, label_key, sort_order) VALUES
  ('post', 'enum.boost_targets.post', 10),
  ('store', 'enum.boost_targets.store', 20);
--> statement-breakpoint

CREATE TABLE public.boost_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boost_statuses_pk PRIMARY KEY (code), CONSTRAINT boost_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER boost_statuses_set_updated_at BEFORE UPDATE ON public.boost_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.boost_statuses (code, label_key, sort_order) VALUES
  ('scheduled', 'enum.boost_statuses.scheduled', 10),
  ('active', 'enum.boost_statuses.active', 20),
  ('stopped', 'enum.boost_statuses.stopped', 30),
  ('expired', 'enum.boost_statuses.expired', 40),
  ('cancelled', 'enum.boost_statuses.cancelled', 50),
  ('refunded', 'enum.boost_statuses.refunded', 60);
--> statement-breakpoint

CREATE TABLE public.boost_stop_reasons (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boost_stop_reasons_pk PRIMARY KEY (code), CONSTRAINT boost_stop_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER boost_stop_reasons_set_updated_at BEFORE UPDATE ON public.boost_stop_reasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.boost_stop_reasons (code, label_key, sort_order) VALUES
  ('post_sold', 'enum.boost_stop_reasons.post_sold', 10),
  ('owner_deleted', 'enum.boost_stop_reasons.owner_deleted', 20),
  ('owner_hidden', 'enum.boost_stop_reasons.owner_hidden', 30),
  ('moderator_removed', 'enum.boost_stop_reasons.moderator_removed', 40),
  ('policy_removed', 'enum.boost_stop_reasons.policy_removed', 50),
  ('legal_hold', 'enum.boost_stop_reasons.legal_hold', 60),
  ('spam_auto', 'enum.boost_stop_reasons.spam_auto', 70),
  ('tenant_closed', 'enum.boost_stop_reasons.tenant_closed', 80);
--> statement-breakpoint

CREATE TABLE public.subscription_subjects (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_subjects_pk PRIMARY KEY (code), CONSTRAINT subscription_subjects_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER subscription_subjects_set_updated_at BEFORE UPDATE ON public.subscription_subjects FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.subscription_subjects (code, label_key, sort_order) VALUES
  ('store', 'enum.subscription_subjects.store', 10),
  ('member', 'enum.subscription_subjects.member', 20);
--> statement-breakpoint

CREATE TABLE public.billing_intervals (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_intervals_pk PRIMARY KEY (code), CONSTRAINT billing_intervals_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER billing_intervals_set_updated_at BEFORE UPDATE ON public.billing_intervals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.billing_intervals (code, label_key, sort_order) VALUES
  ('month', 'enum.billing_intervals.month', 10),
  ('quarter', 'enum.billing_intervals.quarter', 20),
  ('year', 'enum.billing_intervals.year', 30);
--> statement-breakpoint

CREATE TABLE public.subscription_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_statuses_pk PRIMARY KEY (code), CONSTRAINT subscription_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER subscription_statuses_set_updated_at BEFORE UPDATE ON public.subscription_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.subscription_statuses (code, label_key, sort_order) VALUES
  ('pending_payment', 'enum.subscription_statuses.pending_payment', 10),
  ('active', 'enum.subscription_statuses.active', 20),
  ('past_due', 'enum.subscription_statuses.past_due', 30),
  ('cancelled', 'enum.subscription_statuses.cancelled', 40),
  ('expired', 'enum.subscription_statuses.expired', 50);
--> statement-breakpoint

CREATE TABLE public.invoice_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_statuses_pk PRIMARY KEY (code), CONSTRAINT invoice_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER invoice_statuses_set_updated_at BEFORE UPDATE ON public.invoice_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.invoice_statuses (code, label_key, sort_order) VALUES
  ('draft', 'enum.invoice_statuses.draft', 10),
  ('open', 'enum.invoice_statuses.open', 20),
  ('paid', 'enum.invoice_statuses.paid', 30),
  ('void', 'enum.invoice_statuses.void', 40),
  ('refunded', 'enum.invoice_statuses.refunded', 50),
  ('partially_refunded', 'enum.invoice_statuses.partially_refunded', 60);
--> statement-breakpoint

CREATE TABLE public.invoice_line_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_types_pk PRIMARY KEY (code), CONSTRAINT invoice_line_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER invoice_line_types_set_updated_at BEFORE UPDATE ON public.invoice_line_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.invoice_line_types (code, label_key, sort_order) VALUES
  ('credit_package', 'enum.invoice_line_types.credit_package', 10),
  ('subscription', 'enum.invoice_line_types.subscription', 20),
  ('ad_booking', 'enum.invoice_line_types.ad_booking', 30),
  ('verification_fee', 'enum.invoice_line_types.verification_fee', 40),
  ('adjustment', 'enum.invoice_line_types.adjustment', 50);
--> statement-breakpoint

CREATE TABLE public.revenue_streams (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_streams_pk PRIMARY KEY (code), CONSTRAINT revenue_streams_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER revenue_streams_set_updated_at BEFORE UPDATE ON public.revenue_streams FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.revenue_streams (code, label_key, sort_order) VALUES
  ('credits', 'enum.revenue_streams.credits', 10),
  ('subscriptions', 'enum.revenue_streams.subscriptions', 20),
  ('ads', 'enum.revenue_streams.ads', 30),
  ('services', 'enum.revenue_streams.services', 40);
--> statement-breakpoint

CREATE TABLE public.ad_surfaces (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_surfaces_pk PRIMARY KEY (code), CONSTRAINT ad_surfaces_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ad_surfaces_set_updated_at BEFORE UPDATE ON public.ad_surfaces FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ad_surfaces (code, label_key, sort_order) VALUES
  ('web', 'enum.ad_surfaces.web', 10),
  ('app', 'enum.ad_surfaces.app', 20),
  ('both', 'enum.ad_surfaces.both', 30);
--> statement-breakpoint

CREATE TABLE public.ad_creative_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_creative_statuses_pk PRIMARY KEY (code), CONSTRAINT ad_creative_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ad_creative_statuses_set_updated_at BEFORE UPDATE ON public.ad_creative_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ad_creative_statuses (code, label_key, sort_order) VALUES
  ('pending_review', 'enum.ad_creative_statuses.pending_review', 10),
  ('approved', 'enum.ad_creative_statuses.approved', 20),
  ('rejected', 'enum.ad_creative_statuses.rejected', 30);
--> statement-breakpoint

CREATE TABLE public.ad_booking_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_booking_statuses_pk PRIMARY KEY (code), CONSTRAINT ad_booking_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ad_booking_statuses_set_updated_at BEFORE UPDATE ON public.ad_booking_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ad_booking_statuses (code, label_key, sort_order) VALUES
  ('held', 'enum.ad_booking_statuses.held', 10),
  ('confirmed', 'enum.ad_booking_statuses.confirmed', 20),
  ('running', 'enum.ad_booking_statuses.running', 30),
  ('completed', 'enum.ad_booking_statuses.completed', 40),
  ('cancelled', 'enum.ad_booking_statuses.cancelled', 50);
--> statement-breakpoint

-- ============================================================================
-- credit_closure_dispositions (§6.22): GLOBAL — created first because
-- credit_transactions references it.
-- ============================================================================

CREATE TABLE public.credit_closure_dispositions (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  closed_tenant_id         uuid          NOT NULL,
  user_id                  uuid          NOT NULL,
  credits_total            integer       NOT NULL,
  purchased_credits        integer       NOT NULL,
  purchased_value_bdt      numeric(12,2) NOT NULL DEFAULT 0,
  outcome_code             text          NOT NULL,
  destination_tenant_id    uuid,
  destination_rule_code    text,
  destination_distance_km  numeric(8,2),
  refund_deadline_at       timestamptz   NOT NULL,
  refund_status_code       text          NOT NULL DEFAULT 'not_requested',
  refunded_credits         integer       NOT NULL DEFAULT 0,
  refunded_amount          numeric(12,2) NOT NULL DEFAULT 0,
  notified_in_app_at       timestamptz,
  notified_sms_at          timestamptz,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_closure_dispositions_pk PRIMARY KEY (id),
  CONSTRAINT credit_closure_dispositions_closed_tenant_id_fk FOREIGN KEY (closed_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT credit_closure_dispositions_destination_tenant_id_fk FOREIGN KEY (destination_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT credit_closure_dispositions_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT credit_closure_dispositions_outcome_code_fk FOREIGN KEY (outcome_code)
    REFERENCES public.credit_disposition_outcomes (code) ON DELETE RESTRICT,
  CONSTRAINT credit_closure_dispositions_destination_rule_code_fk FOREIGN KEY (destination_rule_code)
    REFERENCES public.port_destination_rules (code) ON DELETE RESTRICT,
  CONSTRAINT credit_closure_dispositions_refund_status_code_fk FOREIGN KEY (refund_status_code)
    REFERENCES public.closure_refund_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT credit_closure_dispositions_credits_total_ck CHECK (credits_total > 0),
  CONSTRAINT credit_closure_dispositions_purchased_credits_ck CHECK (purchased_credits BETWEEN 0 AND credits_total),
  CONSTRAINT credit_closure_dispositions_purchased_value_ck CHECK (purchased_value_bdt >= 0),
  CONSTRAINT credit_closure_dispositions_destination_ck
    CHECK ((outcome_code = 'ported') = (destination_tenant_id IS NOT NULL)),
  CONSTRAINT credit_closure_dispositions_destination_rule_ck
    CHECK ((outcome_code = 'ported') = (destination_rule_code IS NOT NULL)),
  CONSTRAINT credit_closure_dispositions_refunded_credits_ck CHECK (refunded_credits BETWEEN 0 AND purchased_credits),
  CONSTRAINT credit_closure_dispositions_refunded_amount_ck CHECK (refunded_amount BETWEEN 0 AND purchased_value_bdt),
  CONSTRAINT credit_closure_dispositions_closed_tenant_id_user_id_uq UNIQUE (closed_tenant_id, user_id)
);
--> statement-breakpoint
CREATE INDEX credit_closure_dispositions_user_id_idx ON public.credit_closure_dispositions (user_id);
--> statement-breakpoint
CREATE INDEX credit_closure_dispositions_refund_window_idx ON public.credit_closure_dispositions (refund_deadline_at)
  WHERE refund_status_code IN ('not_requested', 'requested');
--> statement-breakpoint
CREATE INDEX credit_closure_dispositions_notify_retry_idx ON public.credit_closure_dispositions (closed_tenant_id)
  WHERE notified_in_app_at IS NULL OR notified_sms_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER credit_closure_dispositions_set_updated_at BEFORE UPDATE ON public.credit_closure_dispositions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- credit_wallets (§6.1): TENANT-SCOPED, PK = (tenant_id, user_id)
-- ============================================================================

CREATE TABLE public.credit_wallets (
  tenant_id       uuid        NOT NULL DEFAULT public.current_tenant_id(),
  user_id         uuid        NOT NULL,
  balance         integer     NOT NULL DEFAULT 0,
  ported_balance  integer     NOT NULL DEFAULT 0,
  frozen_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_wallets_pk PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT credit_wallets_tenant_id_user_id_fk FOREIGN KEY (user_id, tenant_id)
    REFERENCES public.tenant_members (user_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT credit_wallets_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT credit_wallets_balance_ck CHECK (balance >= 0),
  CONSTRAINT credit_wallets_ported_balance_ck CHECK (ported_balance BETWEEN 0 AND balance)
);
--> statement-breakpoint
-- "My credits in every area".
CREATE INDEX credit_wallets_user_id_idx ON public.credit_wallets (user_id);
--> statement-breakpoint
CREATE TRIGGER credit_wallets_set_updated_at BEFORE UPDATE ON public.credit_wallets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Wallets start empty; all credit arrives as credit_transactions rows
-- (through the not-yet-built credit_apply(), see header).
CREATE OR REPLACE FUNCTION public.credit_wallets_require_zero_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.balance <> 0 OR NEW.ported_balance <> 0 THEN
    RAISE EXCEPTION 'credit_wallets: a new wallet must start at zero (tenant %, user %)', NEW.tenant_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_wallets_a_require_zero_start BEFORE INSERT ON public.credit_wallets
  FOR EACH ROW EXECUTE FUNCTION public.credit_wallets_require_zero_start();
--> statement-breakpoint

-- ============================================================================
-- credit_packages (§6.3): GLOBAL, tenant_credit_packages (§6.4): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.credit_packages (
  id              uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  code            text          NOT NULL,
  name_key        text          NOT NULL,
  credits         integer       NOT NULL,
  bonus_credits   integer       NOT NULL DEFAULT 0,
  default_price   numeric(12,2) NOT NULL,
  min_price       numeric(12,2),
  max_price       numeric(12,2),
  is_active       boolean       NOT NULL DEFAULT true,
  sort_order      integer       NOT NULL DEFAULT 0,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_packages_pk PRIMARY KEY (id),
  CONSTRAINT credit_packages_credits_ck CHECK (credits > 0),
  CONSTRAINT credit_packages_bonus_credits_ck CHECK (bonus_credits >= 0),
  CONSTRAINT credit_packages_default_price_ck CHECK (default_price > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX credit_packages_code_uq ON public.credit_packages (code);
--> statement-breakpoint
CREATE TRIGGER credit_packages_set_updated_at BEFORE UPDATE ON public.credit_packages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.tenant_credit_packages (
  id                  uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT public.current_tenant_id(),
  credit_package_id   uuid          NOT NULL,
  price               numeric(12,2),
  is_enabled          boolean       NOT NULL DEFAULT true,
  sort_order          integer       NOT NULL DEFAULT 0,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tenant_credit_packages_pk PRIMARY KEY (id),
  CONSTRAINT tenant_credit_packages_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_credit_packages_credit_package_id_fk FOREIGN KEY (credit_package_id)
    REFERENCES public.credit_packages (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_credit_packages_tenant_id_credit_package_id_uq UNIQUE (tenant_id, credit_package_id)
);
--> statement-breakpoint
CREATE TRIGGER tenant_credit_packages_set_updated_at BEFORE UPDATE ON public.tenant_credit_packages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- A tenant override may not leave the package's [min_price, max_price] band (Q7).
CREATE OR REPLACE FUNCTION public.tenant_credit_packages_validate_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pkg public.credit_packages%ROWTYPE;
BEGIN
  IF NEW.price IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO pkg FROM public.credit_packages WHERE id = NEW.credit_package_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_credit_packages.credit_package_id % does not exist', NEW.credit_package_id;
  END IF;
  IF (pkg.min_price IS NOT NULL AND NEW.price < pkg.min_price)
     OR (pkg.max_price IS NOT NULL AND NEW.price > pkg.max_price) THEN
    RAISE EXCEPTION 'tenant_credit_packages: price % is outside package %''s allowed band', NEW.price, NEW.credit_package_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_credit_packages_a_validate_price
  BEFORE INSERT OR UPDATE OF price, credit_package_id ON public.tenant_credit_packages
  FOR EACH ROW EXECUTE FUNCTION public.tenant_credit_packages_validate_price();
--> statement-breakpoint

-- ============================================================================
-- boost_types (§6.5): GLOBAL, tenant_boost_prices (§6.6): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.boost_types (
  id                       uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  code                     text        NOT NULL,
  name_key                 text        NOT NULL,
  placement_code           text        NOT NULL,
  target_code              text        NOT NULL,
  duration_hours           integer     NOT NULL,
  default_cost_credits     integer     NOT NULL,
  min_cost_credits         integer     NOT NULL,
  max_cost_credits         integer     NOT NULL,
  is_active                boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boost_types_pk PRIMARY KEY (id),
  CONSTRAINT boost_types_placement_code_fk FOREIGN KEY (placement_code)
    REFERENCES public.boost_placements (code) ON DELETE RESTRICT,
  CONSTRAINT boost_types_target_code_fk FOREIGN KEY (target_code)
    REFERENCES public.boost_targets (code) ON DELETE RESTRICT,
  CONSTRAINT boost_types_duration_hours_ck CHECK (duration_hours > 0),
  CONSTRAINT boost_types_default_cost_credits_ck CHECK (default_cost_credits > 0),
  CONSTRAINT boost_types_min_cost_credits_ck CHECK (min_cost_credits > 0 AND min_cost_credits <= default_cost_credits),
  CONSTRAINT boost_types_max_cost_credits_ck CHECK (max_cost_credits >= default_cost_credits)
);
--> statement-breakpoint
CREATE UNIQUE INDEX boost_types_code_uq ON public.boost_types (code);
--> statement-breakpoint
CREATE TRIGGER boost_types_set_updated_at BEFORE UPDATE ON public.boost_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.tenant_boost_prices (
  id             uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT public.current_tenant_id(),
  boost_type_id  uuid        NOT NULL,
  cost_credits   integer,
  is_enabled     boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_boost_prices_pk PRIMARY KEY (id),
  CONSTRAINT tenant_boost_prices_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_boost_prices_boost_type_id_fk FOREIGN KEY (boost_type_id)
    REFERENCES public.boost_types (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_boost_prices_cost_credits_ck CHECK (cost_credits IS NULL OR cost_credits > 0),
  CONSTRAINT tenant_boost_prices_tenant_id_boost_type_id_uq UNIQUE (tenant_id, boost_type_id)
);
--> statement-breakpoint
CREATE TRIGGER tenant_boost_prices_set_updated_at BEFORE UPDATE ON public.tenant_boost_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.tenant_boost_prices_validate_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bt public.boost_types%ROWTYPE;
BEGIN
  IF NEW.cost_credits IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO bt FROM public.boost_types WHERE id = NEW.boost_type_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_boost_prices.boost_type_id % does not exist', NEW.boost_type_id;
  END IF;
  IF NEW.cost_credits < bt.min_cost_credits OR NEW.cost_credits > bt.max_cost_credits THEN
    RAISE EXCEPTION 'tenant_boost_prices: cost_credits % is outside boost type %''s allowed band', NEW.cost_credits, NEW.boost_type_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_boost_prices_a_validate_cost
  BEFORE INSERT OR UPDATE OF cost_credits, boost_type_id ON public.tenant_boost_prices
  FOR EACH ROW EXECUTE FUNCTION public.tenant_boost_prices_validate_cost();
--> statement-breakpoint

-- ============================================================================
-- subscription_plans (§6.8): GLOBAL, tenant_plan_prices (§6.9): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.subscription_plans (
  id                      uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  code                    text          NOT NULL,
  name_key                text          NOT NULL,
  subject_code            text          NOT NULL,
  billing_interval_code   text          NOT NULL,
  default_price           numeric(12,2) NOT NULL,
  min_price               numeric(12,2) NOT NULL,
  max_price               numeric(12,2) NOT NULL,
  included_credits        integer       NOT NULL DEFAULT 0,
  entitlements            jsonb         NOT NULL DEFAULT '{}',
  is_active               boolean       NOT NULL DEFAULT true,
  sort_order              integer       NOT NULL DEFAULT 0,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT subscription_plans_pk PRIMARY KEY (id),
  CONSTRAINT subscription_plans_subject_code_fk FOREIGN KEY (subject_code)
    REFERENCES public.subscription_subjects (code) ON DELETE RESTRICT,
  CONSTRAINT subscription_plans_billing_interval_code_fk FOREIGN KEY (billing_interval_code)
    REFERENCES public.billing_intervals (code) ON DELETE RESTRICT,
  CONSTRAINT subscription_plans_default_price_ck CHECK (default_price >= 0),
  CONSTRAINT subscription_plans_min_price_ck CHECK (min_price BETWEEN 0 AND default_price),
  CONSTRAINT subscription_plans_max_price_ck CHECK (max_price >= default_price),
  CONSTRAINT subscription_plans_entitlements_ck CHECK (jsonb_typeof(entitlements) = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_plans_code_uq ON public.subscription_plans (code);
--> statement-breakpoint
CREATE TRIGGER subscription_plans_set_updated_at BEFORE UPDATE ON public.subscription_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.tenant_plan_prices (
  id                     uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid          NOT NULL DEFAULT public.current_tenant_id(),
  subscription_plan_id   uuid          NOT NULL,
  price                  numeric(12,2),
  is_enabled             boolean       NOT NULL DEFAULT true,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tenant_plan_prices_pk PRIMARY KEY (id),
  CONSTRAINT tenant_plan_prices_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_plan_prices_subscription_plan_id_fk FOREIGN KEY (subscription_plan_id)
    REFERENCES public.subscription_plans (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_plan_prices_tenant_id_plan_id_uq UNIQUE (tenant_id, subscription_plan_id)
);
--> statement-breakpoint
CREATE TRIGGER tenant_plan_prices_set_updated_at BEFORE UPDATE ON public.tenant_plan_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.tenant_plan_prices_validate_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan public.subscription_plans%ROWTYPE;
BEGIN
  IF NEW.price IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO plan FROM public.subscription_plans WHERE id = NEW.subscription_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_plan_prices.subscription_plan_id % does not exist', NEW.subscription_plan_id;
  END IF;
  IF NEW.price < plan.min_price OR NEW.price > plan.max_price THEN
    RAISE EXCEPTION 'tenant_plan_prices: price % is outside plan %''s allowed band', NEW.price, NEW.subscription_plan_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_plan_prices_a_validate_price
  BEFORE INSERT OR UPDATE OF price, subscription_plan_id ON public.tenant_plan_prices
  FOR EACH ROW EXECUTE FUNCTION public.tenant_plan_prices_validate_price();
--> statement-breakpoint

-- ============================================================================
-- subscriptions (§6.10): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.subscriptions (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  subscription_plan_id     uuid          NOT NULL,
  store_id                 uuid,
  member_id                uuid,
  status_code              text          NOT NULL DEFAULT 'pending_payment',
  price                    numeric(12,2) NOT NULL,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean       NOT NULL DEFAULT false,
  cancelled_at             timestamptz,
  grace_ends_at            timestamptz,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_pk PRIMARY KEY (id),
  CONSTRAINT subscriptions_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_subscription_plan_id_fk FOREIGN KEY (subscription_plan_id)
    REFERENCES public.subscription_plans (id) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.subscription_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_subject_ck CHECK (num_nonnulls(store_id, member_id) = 1),
  -- Composite-FK target (§0.4).
  CONSTRAINT subscriptions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- One live subscription per store.
CREATE UNIQUE INDEX subscriptions_tenant_store_live_uq ON public.subscriptions (tenant_id, store_id)
  WHERE store_id IS NOT NULL AND status_code IN ('pending_payment', 'active', 'past_due');
--> statement-breakpoint
-- One live subscription per member.
CREATE UNIQUE INDEX subscriptions_tenant_member_live_uq ON public.subscriptions (tenant_id, member_id)
  WHERE member_id IS NOT NULL AND status_code IN ('pending_payment', 'active', 'past_due');
--> statement-breakpoint
-- Cross-tenant system job: renewal invoices / expiry.
CREATE INDEX subscriptions_status_period_end_idx ON public.subscriptions (status_code, current_period_end)
  WHERE status_code IN ('active', 'past_due');
--> statement-breakpoint
CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- invoices (§6.11): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.invoices (
  id                        uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                 uuid          NOT NULL DEFAULT public.current_tenant_id(),
  invoice_number             text          NOT NULL,
  billed_member_id           uuid          NOT NULL,
  billed_store_id             uuid,
  seller_bin                text          NOT NULL,
  buyer_bin                  text,
  fiscal_year                text          NOT NULL,
  tax_invoice_format_code    text          NOT NULL,  -- FK added with tax_invoice_formats (0008)
  prices_include_vat         boolean       NOT NULL DEFAULT true,
  status_code                text          NOT NULL DEFAULT 'draft',
  currency                   char(3)       NOT NULL DEFAULT 'BDT',
  subtotal                   numeric(12,2) NOT NULL DEFAULT 0,
  discount_total              numeric(12,2) NOT NULL DEFAULT 0,
  tax_total                   numeric(12,2) NOT NULL DEFAULT 0,
  total                       numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid                 numeric(12,2) NOT NULL DEFAULT 0,
  amount_refunded             numeric(12,2) NOT NULL DEFAULT 0,
  issued_at                   timestamptz,
  due_at                      timestamptz,
  paid_at                     timestamptz,
  voided_at                   timestamptz,
  void_reason                 text,
  created_at                 timestamptz   NOT NULL DEFAULT now(),
  updated_at                 timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT invoices_pk PRIMARY KEY (id),
  CONSTRAINT invoices_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT invoices_tenant_id_billed_member_id_fk FOREIGN KEY (tenant_id, billed_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoices_tenant_id_billed_store_id_fk FOREIGN KEY (tenant_id, billed_store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoices_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.invoice_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT invoices_fiscal_year_ck CHECK (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT invoices_subtotal_ck CHECK (subtotal >= 0),
  CONSTRAINT invoices_discount_total_ck CHECK (discount_total >= 0),
  CONSTRAINT invoices_total_ck CHECK (total = subtotal - discount_total + tax_total),
  CONSTRAINT invoices_amount_paid_ck CHECK (amount_paid BETWEEN 0 AND total),
  CONSTRAINT invoices_amount_refunded_ck CHECK (amount_refunded BETWEEN 0 AND amount_paid),
  -- Composite-FK target (§0.4).
  CONSTRAINT invoices_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX invoices_tenant_id_invoice_number_uq ON public.invoices (tenant_id, invoice_number);
--> statement-breakpoint
-- "My invoices".
CREATE INDEX invoices_tenant_billed_member_idx ON public.invoices (tenant_id, billed_member_id, id DESC);
--> statement-breakpoint
-- Unpaid invoices list, reminder job.
CREATE INDEX invoices_tenant_open_due_idx ON public.invoices (tenant_id, status_code, due_at)
  WHERE status_code = 'open';
--> statement-breakpoint
CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- No DELETE, and no further mutation of the fixed/issued fields, once issued.
CREATE OR REPLACE FUNCTION public.invoices_prevent_mutation_after_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'invoices: an issued invoice cannot be deleted (id %)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.issued_at IS NOT NULL AND NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION 'invoices: invoice_number is immutable once issued (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_a_prevent_mutation_after_issue BEFORE UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_prevent_mutation_after_issue();
--> statement-breakpoint

-- ============================================================================
-- ad_slots (§6.13): GLOBAL, ad_inventory (§6.14): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.ad_slots (
  id                              uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  code                            text          NOT NULL,
  name_key                        text          NOT NULL,
  surface_code                    text          NOT NULL,
  width_px                        integer       NOT NULL,
  height_px                       integer       NOT NULL,
  max_positions                   smallint      NOT NULL DEFAULT 1,
  supports_category_targeting     boolean       NOT NULL DEFAULT false,
  default_price_per_day           numeric(12,2) NOT NULL,
  min_price_per_day               numeric(12,2) NOT NULL,
  max_price_per_day               numeric(12,2) NOT NULL,
  is_active                       boolean       NOT NULL DEFAULT true,
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ad_slots_pk PRIMARY KEY (id),
  CONSTRAINT ad_slots_surface_code_fk FOREIGN KEY (surface_code)
    REFERENCES public.ad_surfaces (code) ON DELETE RESTRICT,
  CONSTRAINT ad_slots_max_positions_ck CHECK (max_positions >= 1),
  CONSTRAINT ad_slots_min_price_per_day_ck CHECK (min_price_per_day > 0 AND min_price_per_day <= default_price_per_day),
  CONSTRAINT ad_slots_max_price_per_day_ck CHECK (max_price_per_day >= default_price_per_day)
);
--> statement-breakpoint
CREATE UNIQUE INDEX ad_slots_code_uq ON public.ad_slots (code);
--> statement-breakpoint
CREATE TRIGGER ad_slots_set_updated_at BEFORE UPDATE ON public.ad_slots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE public.ad_inventory (
  id             uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id      uuid          NOT NULL DEFAULT public.current_tenant_id(),
  ad_slot_id     uuid          NOT NULL,
  category_id    uuid,
  positions      smallint      NOT NULL DEFAULT 1,
  price_per_day  numeric(12,2) NOT NULL,
  is_enabled     boolean       NOT NULL DEFAULT true,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ad_inventory_pk PRIMARY KEY (id),
  CONSTRAINT ad_inventory_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT ad_inventory_ad_slot_id_fk FOREIGN KEY (ad_slot_id)
    REFERENCES public.ad_slots (id) ON DELETE RESTRICT,
  CONSTRAINT ad_inventory_category_id_fk FOREIGN KEY (category_id)
    REFERENCES public.categories (id) ON DELETE RESTRICT,
  CONSTRAINT ad_inventory_price_per_day_ck CHECK (price_per_day > 0),
  -- Composite-FK target (§0.4).
  CONSTRAINT ad_inventory_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- No duplicate inventory rows (PG15+ syntax so NULL category counts once).
CREATE UNIQUE INDEX ad_inventory_tenant_slot_category_uq ON public.ad_inventory
  (tenant_id, ad_slot_id, category_id) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE TRIGGER ad_inventory_set_updated_at BEFORE UPDATE ON public.ad_inventory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ad_inventory_validate_bounds()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  slot public.ad_slots%ROWTYPE;
BEGIN
  SELECT * INTO slot FROM public.ad_slots WHERE id = NEW.ad_slot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ad_inventory.ad_slot_id % does not exist', NEW.ad_slot_id;
  END IF;
  IF NEW.positions < 1 OR NEW.positions > slot.max_positions THEN
    RAISE EXCEPTION 'ad_inventory: positions % is outside slot %''s max_positions', NEW.positions, NEW.ad_slot_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.price_per_day < slot.min_price_per_day OR NEW.price_per_day > slot.max_price_per_day THEN
    RAISE EXCEPTION 'ad_inventory: price_per_day % is outside slot %''s allowed band', NEW.price_per_day, NEW.ad_slot_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ad_inventory_a_validate_bounds
  BEFORE INSERT OR UPDATE OF positions, price_per_day, ad_slot_id ON public.ad_inventory
  FOR EACH ROW EXECUTE FUNCTION public.ad_inventory_validate_bounds();
--> statement-breakpoint

-- ============================================================================
-- ad_creatives (§6.15): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.ad_creatives (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  advertiser_member_id   uuid        NOT NULL,
  store_id               uuid,
  media_asset_id         uuid        NOT NULL,
  headline               text,
  target_url             text,
  status_code            text        NOT NULL DEFAULT 'pending_review',
  reviewed_by_user_id    uuid,
  reviewed_at            timestamptz,
  rejection_reason_code  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT ad_creatives_pk PRIMARY KEY (id),
  CONSTRAINT ad_creatives_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT ad_creatives_tenant_id_advertiser_member_id_fk FOREIGN KEY (tenant_id, advertiser_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ad_creatives_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL (store_id),
  CONSTRAINT ad_creatives_tenant_id_media_asset_id_fk FOREIGN KEY (tenant_id, media_asset_id)
    REFERENCES public.media_assets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ad_creatives_reviewed_by_user_id_fk FOREIGN KEY (reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT ad_creatives_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.ad_creative_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT ad_creatives_rejection_reason_code_fk FOREIGN KEY (rejection_reason_code)
    REFERENCES public.moderation_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT ad_creatives_target_url_ck CHECK (target_url IS NULL OR target_url ~ '^https://'),
  -- Composite-FK target (§0.4).
  CONSTRAINT ad_creatives_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Advertiser's creatives.
CREATE INDEX ad_creatives_tenant_advertiser_idx ON public.ad_creatives (tenant_id, advertiser_member_id, id DESC);
--> statement-breakpoint
-- Review queue.
CREATE INDEX ad_creatives_pending_idx ON public.ad_creatives (tenant_id, id)
  WHERE status_code = 'pending_review';
--> statement-breakpoint
CREATE TRIGGER ad_creatives_set_updated_at BEFORE UPDATE ON public.ad_creatives
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- An advertiser's own edit resets the creative to pending_review.
CREATE OR REPLACE FUNCTION public.ad_creatives_reset_on_advertiser_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.app_is_staff() THEN
    NEW.status_code := 'pending_review';
    NEW.reviewed_by_user_id := NULL;
    NEW.reviewed_at := NULL;
    NEW.rejection_reason_code := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ad_creatives_a_reset_on_advertiser_edit BEFORE UPDATE ON public.ad_creatives
  FOR EACH ROW EXECUTE FUNCTION public.ad_creatives_reset_on_advertiser_edit();
--> statement-breakpoint

-- ============================================================================
-- ad_bookings (§6.16): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.ad_bookings (
  id                    uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid          NOT NULL DEFAULT public.current_tenant_id(),
  ad_inventory_id       uuid          NOT NULL,
  ad_creative_id        uuid          NOT NULL,
  advertiser_member_id  uuid          NOT NULL,
  "position"            smallint      NOT NULL,
  starts_on             date          NOT NULL,
  ends_on               date          NOT NULL,
  price_per_day         numeric(12,2) NOT NULL,
  total_price           numeric(12,2) NOT NULL,
  invoice_id            uuid,
  status_code           text          NOT NULL DEFAULT 'held',
  hold_expires_at       timestamptz,
  booked_by_user_id     uuid,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ad_bookings_pk PRIMARY KEY (id),
  CONSTRAINT ad_bookings_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT ad_bookings_tenant_id_ad_inventory_id_fk FOREIGN KEY (tenant_id, ad_inventory_id)
    REFERENCES public.ad_inventory (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ad_bookings_tenant_id_ad_creative_id_fk FOREIGN KEY (tenant_id, ad_creative_id)
    REFERENCES public.ad_creatives (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ad_bookings_tenant_id_advertiser_member_id_fk FOREIGN KEY (tenant_id, advertiser_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ad_bookings_tenant_id_invoice_id_fk FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ad_bookings_booked_by_user_id_fk FOREIGN KEY (booked_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT ad_bookings_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.ad_booking_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT ad_bookings_ends_on_ck CHECK (ends_on >= starts_on),
  CONSTRAINT ad_bookings_total_price_ck CHECK (total_price = price_per_day * (ends_on - starts_on + 1)),
  CONSTRAINT ad_bookings_hold_expires_at_ck CHECK (status_code <> 'held' OR hold_expires_at IS NOT NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT ad_bookings_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- No double-booking a position — the inventory guarantee.
  CONSTRAINT ad_bookings_no_overlap_excl EXCLUDE USING gist (
    tenant_id WITH =,
    ad_inventory_id WITH =,
    "position" WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (status_code IN ('held', 'confirmed', 'running'))
);
--> statement-breakpoint
-- Ad server: "what runs today in this slot".
CREATE INDEX ad_bookings_running_idx ON public.ad_bookings (tenant_id, ad_inventory_id, starts_on, ends_on)
  WHERE status_code IN ('confirmed', 'running');
--> statement-breakpoint
-- Cross-tenant system job: release expired holds.
CREATE INDEX ad_bookings_held_expiry_idx ON public.ad_bookings (status_code, hold_expires_at)
  WHERE status_code = 'held';
--> statement-breakpoint
-- "My ads".
CREATE INDEX ad_bookings_tenant_advertiser_idx ON public.ad_bookings (tenant_id, advertiser_member_id, id DESC);
--> statement-breakpoint
CREATE TRIGGER ad_bookings_set_updated_at BEFORE UPDATE ON public.ad_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- ad_daily_stats (§6.17): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.ad_daily_stats (
  id             uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT public.current_tenant_id(),
  ad_booking_id  uuid        NOT NULL,
  stat_date      date        NOT NULL,
  impressions    integer     NOT NULL DEFAULT 0,
  clicks         integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_daily_stats_pk PRIMARY KEY (id),
  CONSTRAINT ad_daily_stats_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT ad_daily_stats_tenant_id_ad_booking_id_fk FOREIGN KEY (tenant_id, ad_booking_id)
    REFERENCES public.ad_bookings (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ad_daily_stats_impressions_ck CHECK (impressions >= 0),
  CONSTRAINT ad_daily_stats_clicks_ck CHECK (clicks >= 0)
);
--> statement-breakpoint
-- Idempotent upsert from the nightly flush job.
CREATE UNIQUE INDEX ad_daily_stats_tenant_booking_date_uq ON public.ad_daily_stats (tenant_id, ad_booking_id, stat_date);
--> statement-breakpoint
CREATE TRIGGER ad_daily_stats_set_updated_at BEFORE UPDATE ON public.ad_daily_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- invoice_lines (§6.12): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.invoice_lines (
  id                    uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid          NOT NULL DEFAULT public.current_tenant_id(),
  invoice_id            uuid          NOT NULL,
  line_type_code        text          NOT NULL,
  revenue_stream_code   text          NOT NULL,
  description_key       text          NOT NULL,
  description_params    jsonb         NOT NULL DEFAULT '{}',
  quantity              integer       NOT NULL DEFAULT 1,
  unit_price            numeric(12,2) NOT NULL,
  discount              numeric(12,2) NOT NULL DEFAULT 0,
  line_total            numeric(12,2) NOT NULL,
  vat_rate              numeric(5,4)  NOT NULL,
  vat_amount            numeric(12,2) NOT NULL DEFAULT 0,
  credit_package_id     uuid,
  subscription_id       uuid,
  ad_booking_id         uuid,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT invoice_lines_pk PRIMARY KEY (id),
  CONSTRAINT invoice_lines_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_lines_tenant_id_invoice_id_fk FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_lines_line_type_code_fk FOREIGN KEY (line_type_code)
    REFERENCES public.invoice_line_types (code) ON DELETE RESTRICT,
  CONSTRAINT invoice_lines_revenue_stream_code_fk FOREIGN KEY (revenue_stream_code)
    REFERENCES public.revenue_streams (code) ON DELETE RESTRICT,
  CONSTRAINT invoice_lines_credit_package_id_fk FOREIGN KEY (credit_package_id)
    REFERENCES public.credit_packages (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_lines_tenant_id_subscription_id_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES public.subscriptions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_lines_tenant_id_ad_booking_id_fk FOREIGN KEY (tenant_id, ad_booking_id)
    REFERENCES public.ad_bookings (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_lines_quantity_ck CHECK (quantity > 0),
  CONSTRAINT invoice_lines_line_total_ck CHECK (line_total = quantity * unit_price - discount),
  CONSTRAINT invoice_lines_vat_amount_ck CHECK (vat_amount >= 0),
  CONSTRAINT invoice_lines_description_params_ck CHECK (jsonb_typeof(description_params) = 'object')
);
--> statement-breakpoint
CREATE INDEX invoice_lines_tenant_invoice_idx ON public.invoice_lines (tenant_id, invoice_id);
--> statement-breakpoint
CREATE TRIGGER invoice_lines_set_updated_at BEFORE UPDATE ON public.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Lines are immutable once the parent invoice is issued.
CREATE OR REPLACE FUNCTION public.invoice_lines_prevent_mutation_after_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_invoice_id uuid;
  issued timestamptz;
BEGIN
  target_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT issued_at INTO issued FROM public.invoices WHERE id = target_invoice_id;
  IF issued IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_lines: cannot modify lines of an issued invoice (invoice %)', target_invoice_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_a_prevent_mutation_after_issue
  BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.invoice_lines_prevent_mutation_after_issue();
--> statement-breakpoint

-- Keeps the parent invoice's subtotal/tax_total/total in sync with its lines.
CREATE OR REPLACE FUNCTION public.invoice_lines_sync_parent_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_invoice_id uuid;
  new_subtotal numeric(12,2);
  new_tax_total numeric(12,2);
BEGIN
  target_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT coalesce(SUM(line_total), 0), coalesce(SUM(vat_amount), 0)
    INTO new_subtotal, new_tax_total
    FROM public.invoice_lines WHERE invoice_id = target_invoice_id;
  UPDATE public.invoices
    SET subtotal = new_subtotal, tax_total = new_tax_total, total = new_subtotal - discount_total + new_tax_total
    WHERE id = target_invoice_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_b_sync_parent_totals
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.invoice_lines_sync_parent_totals();
--> statement-breakpoint

-- ============================================================================
-- credit_transactions (§6.2): TENANT-SCOPED, append-only ledger
-- ============================================================================

CREATE TABLE public.credit_transactions (
  id                                  uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                           uuid          NOT NULL DEFAULT public.current_tenant_id(),
  user_id                             uuid          NOT NULL,
  amount                              integer       NOT NULL,
  balance_after                       integer       NOT NULL,
  reason_code                         text          NOT NULL,
  is_purchased                        boolean       NOT NULL DEFAULT false,
  origin_tenant_id                    uuid,
  platform_share_rate_provisional     numeric(5,4),
  platform_share_rate_final           numeric(9,8),
  platform_share_bdt_final            numeric(12,2),
  credit_closure_disposition_id       uuid,
  payment_id                          uuid,  -- FK added with payments (0008)
  invoice_id                          uuid,
  post_id                             uuid,
  subscription_id                     uuid,
  reverses_transaction_id             uuid,
  actor_user_id                       uuid,
  note                                text,
  idempotency_key                     text          NOT NULL,
  created_at                          timestamptz   NOT NULL DEFAULT now(),
  updated_at                          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_transactions_pk PRIMARY KEY (id),
  CONSTRAINT credit_transactions_tenant_id_user_id_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES public.credit_wallets (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_tenant_id_invoice_id_fk FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_tenant_id_subscription_id_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES public.subscriptions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_tenant_id_reverses_fk FOREIGN KEY (tenant_id, reverses_transaction_id)
    REFERENCES public.credit_transactions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT credit_transactions_origin_tenant_id_fk FOREIGN KEY (origin_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.credit_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_disposition_id_fk FOREIGN KEY (credit_closure_disposition_id)
    REFERENCES public.credit_closure_dispositions (id) ON DELETE RESTRICT,
  CONSTRAINT credit_transactions_amount_ck CHECK (amount <> 0),
  CONSTRAINT credit_transactions_balance_after_ck CHECK (balance_after >= 0),
  CONSTRAINT credit_transactions_is_purchased_amount_ck CHECK (NOT is_purchased OR amount > 0),
  CONSTRAINT credit_transactions_purchase_is_purchased_ck CHECK ((reason_code = 'purchase') <= is_purchased),
  CONSTRAINT credit_transactions_origin_tenant_ck
    CHECK ((origin_tenant_id IS NOT NULL) = (reason_code IN ('tenant_closure_transfer_in', 'platform_pool_restore'))),
  CONSTRAINT credit_transactions_rate_provisional_ck
    CHECK ((reason_code = 'purchase') = (platform_share_rate_provisional IS NOT NULL)),
  CONSTRAINT credit_transactions_rate_provisional_range_ck
    CHECK (platform_share_rate_provisional IS NULL OR platform_share_rate_provisional BETWEEN 0 AND 1),
  CONSTRAINT credit_transactions_rate_final_ck
    CHECK (platform_share_rate_final IS NULL OR reason_code = 'purchase'),
  CONSTRAINT credit_transactions_bdt_final_ck
    CHECK ((platform_share_rate_final IS NULL) = (platform_share_bdt_final IS NULL)),
  CONSTRAINT credit_transactions_disposition_required_ck CHECK (
    (reason_code IN (
      'tenant_closure_transfer_out', 'tenant_closure_transfer_in',
      'platform_pool_park', 'platform_pool_restore', 'closure_cash_refund'
    )) = (credit_closure_disposition_id IS NOT NULL)
  ),
  CONSTRAINT credit_transactions_note_ck CHECK (reason_code <> 'admin_adjustment' OR note IS NOT NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT credit_transactions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX credit_transactions_idempotency_key_uq ON public.credit_transactions (idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX credit_transactions_reverses_uq ON public.credit_transactions (tenant_id, reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
--> statement-breakpoint
-- Wallet history; newest row for the commit check; tenant_id index.
CREATE INDEX credit_transactions_tenant_user_idx ON public.credit_transactions (tenant_id, user_id, id DESC);
--> statement-breakpoint
-- Refund -> clawback lookup.
CREATE INDEX credit_transactions_payment_id_idx ON public.credit_transactions (payment_id)
  WHERE payment_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER credit_transactions_set_updated_at BEFORE UPDATE ON public.credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Immutable, with the one narrow exception spec carves out (the month-close
-- back-fill of platform_share_rate_final/_bdt_final from NULL) — that job is
-- itself deferred (see header), so for now this is unconditionally immutable;
-- revisit together when the back-fill job is built.
CREATE OR REPLACE FUNCTION public.credit_transactions_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit_transactions rows are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_transactions_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.credit_transactions_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- credit_lots (§6.18): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.credit_lots (
  id                          uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                   uuid          NOT NULL DEFAULT public.current_tenant_id(),
  user_id                     uuid          NOT NULL,
  source_transaction_id       uuid          NOT NULL,
  is_purchased                boolean       NOT NULL,
  credits_granted             integer       NOT NULL,
  credits_remaining           integer       NOT NULL,
  purchase_amount_bdt         numeric(12,2),
  value_remaining_bdt         numeric(12,2) NOT NULL DEFAULT 0,
  payment_id                  uuid,  -- FK added with payments (0008)
  origin_tenant_id            uuid,
  purchase_transaction_id     uuid,
  sold_under_partner_id       uuid,
  expires_at                  timestamptz,
  origin_lot_id                uuid,
  originally_purchased_at      timestamptz,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_lots_pk PRIMARY KEY (id),
  CONSTRAINT credit_lots_tenant_id_user_id_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES public.credit_wallets (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT credit_lots_tenant_id_source_transaction_id_fk FOREIGN KEY (tenant_id, source_transaction_id)
    REFERENCES public.credit_transactions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_lots_origin_tenant_id_fk FOREIGN KEY (origin_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT credit_lots_origin_lot_id_fk FOREIGN KEY (origin_lot_id)
    REFERENCES public.credit_lots (id) ON DELETE RESTRICT,
  CONSTRAINT credit_lots_purchase_transaction_id_fk FOREIGN KEY (purchase_transaction_id)
    REFERENCES public.credit_transactions (id) ON DELETE RESTRICT,
  CONSTRAINT credit_lots_sold_under_partner_id_fk FOREIGN KEY (sold_under_partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT credit_lots_credits_granted_ck CHECK (credits_granted > 0),
  CONSTRAINT credit_lots_credits_remaining_ck CHECK (credits_remaining BETWEEN 0 AND credits_granted),
  CONSTRAINT credit_lots_purchase_amount_ck CHECK (is_purchased = (purchase_amount_bdt IS NOT NULL)),
  CONSTRAINT credit_lots_value_remaining_ck
    CHECK (value_remaining_bdt BETWEEN 0 AND coalesce(purchase_amount_bdt, 0)),
  CONSTRAINT credit_lots_value_remaining_zero_ck
    CHECK (credits_remaining > 0 OR value_remaining_bdt = 0),
  CONSTRAINT credit_lots_purchase_transaction_ck CHECK (is_purchased = (purchase_transaction_id IS NOT NULL)),
  CONSTRAINT credit_lots_sold_under_partner_ck CHECK (is_purchased = (sold_under_partner_id IS NOT NULL)),
  CONSTRAINT credit_lots_expires_at_ck CHECK (NOT is_purchased OR expires_at IS NULL),
  -- Composite-FK target (§0.4).
  CONSTRAINT credit_lots_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX credit_lots_tenant_source_transaction_uq ON public.credit_lots (tenant_id, source_transaction_id);
--> statement-breakpoint
-- Allocation order: bonus by expiry, then purchased FIFO.
CREATE INDEX credit_lots_allocation_order_idx
  ON public.credit_lots (tenant_id, user_id, is_purchased, expires_at, originally_purchased_at, id)
  WHERE credits_remaining > 0;
--> statement-breakpoint
-- Cross-tenant bonus-expiry job.
CREATE INDEX credit_lots_expiry_idx ON public.credit_lots (expires_at)
  WHERE expires_at IS NOT NULL AND credits_remaining > 0;
--> statement-breakpoint
-- Ported liability per origin.
CREATE INDEX credit_lots_tenant_origin_idx ON public.credit_lots (tenant_id, origin_tenant_id)
  WHERE origin_tenant_id IS NOT NULL AND credits_remaining > 0;
--> statement-breakpoint
CREATE INDEX credit_lots_payment_id_idx ON public.credit_lots (payment_id) WHERE payment_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX credit_lots_origin_lot_id_idx ON public.credit_lots (origin_lot_id) WHERE origin_lot_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER credit_lots_set_updated_at BEFORE UPDATE ON public.credit_lots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- credit_lot_allocations (§6.19): TENANT-SCOPED, immutable
-- ============================================================================

CREATE TABLE public.credit_lot_allocations (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  credit_transaction_id    uuid          NOT NULL,
  credit_lot_id            uuid          NOT NULL,
  credits                  integer       NOT NULL,
  value_bdt                numeric(12,2) NOT NULL DEFAULT 0,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_lot_allocations_pk PRIMARY KEY (id),
  CONSTRAINT credit_lot_allocations_tenant_id_tx_fk FOREIGN KEY (tenant_id, credit_transaction_id)
    REFERENCES public.credit_transactions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_lot_allocations_tenant_id_lot_fk FOREIGN KEY (tenant_id, credit_lot_id)
    REFERENCES public.credit_lots (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT credit_lot_allocations_credits_ck CHECK (credits > 0),
  CONSTRAINT credit_lot_allocations_value_bdt_ck CHECK (value_bdt >= 0),
  CONSTRAINT credit_lot_allocations_tenant_tx_lot_uq UNIQUE (tenant_id, credit_transaction_id, credit_lot_id)
);
--> statement-breakpoint
CREATE INDEX credit_lot_allocations_tenant_lot_idx ON public.credit_lot_allocations (tenant_id, credit_lot_id);
--> statement-breakpoint
CREATE TRIGGER credit_lot_allocations_set_updated_at BEFORE UPDATE ON public.credit_lot_allocations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER credit_lot_allocations_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.credit_lot_allocations
  FOR EACH ROW EXECUTE FUNCTION public.credit_transactions_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- tenant_credit_liability (§6.20): TENANT-SCOPED, 1:1 with tenants
-- ============================================================================

CREATE TABLE public.tenant_credit_liability (
  tenant_id                       uuid          NOT NULL,
  outstanding_credits              bigint        NOT NULL DEFAULT 0,
  outstanding_purchased_credits    bigint        NOT NULL DEFAULT 0,
  liability_bdt                    numeric(12,2) NOT NULL DEFAULT 0,
  ported_outstanding_credits       bigint        NOT NULL DEFAULT 0,
  ported_liability_bdt             numeric(12,2) NOT NULL DEFAULT 0,
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tenant_credit_liability_pk PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_credit_liability_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_credit_liability_outstanding_credits_ck CHECK (outstanding_credits >= 0),
  CONSTRAINT tenant_credit_liability_outstanding_purchased_ck
    CHECK (outstanding_purchased_credits BETWEEN 0 AND outstanding_credits),
  CONSTRAINT tenant_credit_liability_liability_bdt_ck CHECK (liability_bdt >= 0),
  CONSTRAINT tenant_credit_liability_ported_credits_ck CHECK (ported_outstanding_credits >= 0),
  CONSTRAINT tenant_credit_liability_ported_liability_bdt_ck CHECK (ported_liability_bdt >= 0)
);
--> statement-breakpoint
CREATE TRIGGER tenant_credit_liability_set_updated_at BEFORE UPDATE ON public.tenant_credit_liability
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- platform_credit_pool (§6.21): GLOBAL
-- ============================================================================

CREATE TABLE public.platform_credit_pool (
  id                            uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id                       uuid          NOT NULL,
  origin_tenant_id              uuid          NOT NULL,
  origin_lot_id                 uuid          NOT NULL,
  credit_closure_disposition_id uuid          NOT NULL,
  is_purchased                  boolean       NOT NULL,
  credits                       integer       NOT NULL,
  value_bdt                     numeric(12,2) NOT NULL DEFAULT 0,
  payment_id                    uuid,  -- FK added with payments (0008)
  status_code                   text          NOT NULL DEFAULT 'held',
  parked_at                     timestamptz   NOT NULL DEFAULT now(),
  restored_at                   timestamptz,
  restored_to_tenant_id         uuid,
  restore_transaction_id        uuid,
  refunded_at                   timestamptz,
  refund_id                     uuid,  -- FK added with refunds (0008)
  created_at                    timestamptz   NOT NULL DEFAULT now(),
  updated_at                    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT platform_credit_pool_pk PRIMARY KEY (id),
  CONSTRAINT platform_credit_pool_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_origin_tenant_id_fk FOREIGN KEY (origin_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_restored_to_tenant_id_fk FOREIGN KEY (restored_to_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_origin_lot_id_fk FOREIGN KEY (origin_lot_id)
    REFERENCES public.credit_lots (id) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_disposition_id_fk FOREIGN KEY (credit_closure_disposition_id)
    REFERENCES public.credit_closure_dispositions (id) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_restore_transaction_id_fk FOREIGN KEY (restore_transaction_id)
    REFERENCES public.credit_transactions (id) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.credit_pool_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT platform_credit_pool_credits_ck CHECK (credits > 0),
  CONSTRAINT platform_credit_pool_value_bdt_ck CHECK (value_bdt >= 0),
  CONSTRAINT platform_credit_pool_value_bdt_purchased_ck CHECK (is_purchased OR value_bdt = 0),
  CONSTRAINT platform_credit_pool_restored_ck CHECK ((status_code = 'restored') = (restored_to_tenant_id IS NOT NULL)),
  CONSTRAINT platform_credit_pool_refunded_ck
    CHECK ((status_code = 'refunded') = (refund_id IS NOT NULL) AND (status_code <> 'refunded' OR is_purchased))
);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_credit_pool_origin_lot_id_uq ON public.platform_credit_pool (origin_lot_id);
--> statement-breakpoint
-- Restore on user activity; "my parked credits".
CREATE INDEX platform_credit_pool_user_held_idx ON public.platform_credit_pool (user_id)
  WHERE status_code = 'held';
--> statement-breakpoint
-- Restore when the area gets a new tenant.
CREATE INDEX platform_credit_pool_origin_tenant_held_idx ON public.platform_credit_pool (origin_tenant_id)
  WHERE status_code = 'held';
--> statement-breakpoint
CREATE TRIGGER platform_credit_pool_set_updated_at BEFORE UPDATE ON public.platform_credit_pool
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- credit_liability_settlements (§6.23): GLOBAL, immutable except true-up
-- ============================================================================

CREATE TABLE public.credit_liability_settlements (
  id                        uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  settlement_kind_code       text          NOT NULL,
  from_tenant_id             uuid          NOT NULL,
  to_tenant_id                uuid          NOT NULL,
  from_partner_id             uuid          NOT NULL,
  to_partner_id                uuid          NOT NULL,
  user_id                    uuid          NOT NULL,
  credits                    integer       NOT NULL,
  credit_value_bdt            numeric(12,2) NOT NULL,
  origin_rate                numeric(9,8)  NOT NULL,
  origin_rate_is_final        boolean       NOT NULL,
  spender_rate                numeric(9,8)  NOT NULL,
  spender_rate_is_final       boolean       NOT NULL,
  payout_rate                 numeric(9,8)  NOT NULL,
  payout_bdt                  numeric(12,2) NOT NULL,
  reserve_funded_bdt          numeric(12,2) NOT NULL,
  continuity_subsidy_bdt       numeric(12,2) NOT NULL DEFAULT 0,
  subsidy_capped               boolean       NOT NULL DEFAULT false,
  credit_transaction_id        uuid          NOT NULL,
  credit_lot_id                uuid          NOT NULL,
  journal_id                  uuid          NOT NULL,  -- FK added with settlement_ledger_entries (0008)
  settled_at                  timestamptz   NOT NULL DEFAULT now(),
  trued_up_at                 timestamptz,
  true_up_delta_bdt            numeric(12,2),
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_liability_settlements_pk PRIMARY KEY (id),
  CONSTRAINT credit_liability_settlements_kind_code_fk FOREIGN KEY (settlement_kind_code)
    REFERENCES public.liability_settlement_kinds (code) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_from_tenant_id_fk FOREIGN KEY (from_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_to_tenant_id_fk FOREIGN KEY (to_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_from_partner_id_fk FOREIGN KEY (from_partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_to_partner_id_fk FOREIGN KEY (to_partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_credit_transaction_id_fk FOREIGN KEY (credit_transaction_id)
    REFERENCES public.credit_transactions (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_credit_lot_id_fk FOREIGN KEY (credit_lot_id)
    REFERENCES public.credit_lots (id) ON DELETE RESTRICT,
  CONSTRAINT credit_liability_settlements_transfer_same_tenant_ck
    CHECK ((settlement_kind_code = 'partner_transfer') = (from_tenant_id = to_tenant_id)),
  CONSTRAINT credit_liability_settlements_distinct_ck
    CHECK (from_partner_id <> to_partner_id OR from_tenant_id <> to_tenant_id),
  CONSTRAINT credit_liability_settlements_credits_ck CHECK (credits > 0),
  CONSTRAINT credit_liability_settlements_credit_value_bdt_ck CHECK (credit_value_bdt >= 0),
  CONSTRAINT credit_liability_settlements_payout_bdt_ck
    CHECK (payout_bdt = reserve_funded_bdt + continuity_subsidy_bdt),
  CONSTRAINT credit_liability_settlements_continuity_subsidy_ck CHECK (
    continuity_subsidy_bdt >= 0 AND (settlement_kind_code <> 'partner_transfer' OR continuity_subsidy_bdt = 0)
  ),
  CONSTRAINT credit_liability_settlements_tx_lot_uq UNIQUE (credit_transaction_id, credit_lot_id)
);
--> statement-breakpoint
-- Reserve / handover-fund drawdown.
CREATE INDEX credit_liability_settlements_from_tenant_idx ON public.credit_liability_settlements (from_tenant_id, settled_at);
--> statement-breakpoint
-- Spending partner's earnings; subsidy month-to-date sum.
CREATE INDEX credit_liability_settlements_to_tenant_idx ON public.credit_liability_settlements (to_tenant_id, settled_at);
--> statement-breakpoint
-- Cross-tenant true-up job.
CREATE INDEX credit_liability_settlements_true_up_idx ON public.credit_liability_settlements (settled_at)
  WHERE NOT (origin_rate_is_final AND spender_rate_is_final);
--> statement-breakpoint
-- Support: "where did my credits go".
CREATE INDEX credit_liability_settlements_user_idx ON public.credit_liability_settlements (user_id, settled_at);
--> statement-breakpoint
CREATE TRIGGER credit_liability_settlements_set_updated_at BEFORE UPDATE ON public.credit_liability_settlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Immutable except the one-time true-up columns (trued_up_at,
-- true_up_delta_bdt), and only moving those from NULL once.
CREATE OR REPLACE FUNCTION public.credit_liability_settlements_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_liability_settlements rows are immutable (DELETE blocked)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.trued_up_at IS NOT NULL THEN
    RAISE EXCEPTION 'credit_liability_settlements: already trued up (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only trued_up_at/true_up_delta_bdt (and updated_at) may change; a
  -- genuine no-op update also passes this check since nothing differs.
  IF row(NEW.id, NEW.settlement_kind_code, NEW.from_tenant_id, NEW.to_tenant_id, NEW.from_partner_id,
         NEW.to_partner_id, NEW.user_id, NEW.credits, NEW.credit_value_bdt, NEW.origin_rate,
         NEW.origin_rate_is_final, NEW.spender_rate, NEW.spender_rate_is_final, NEW.payout_rate,
         NEW.payout_bdt, NEW.reserve_funded_bdt, NEW.continuity_subsidy_bdt, NEW.subsidy_capped,
         NEW.credit_transaction_id, NEW.credit_lot_id, NEW.journal_id, NEW.settled_at)
      IS DISTINCT FROM
      row(OLD.id, OLD.settlement_kind_code, OLD.from_tenant_id, OLD.to_tenant_id, OLD.from_partner_id,
         OLD.to_partner_id, OLD.user_id, OLD.credits, OLD.credit_value_bdt, OLD.origin_rate,
         OLD.origin_rate_is_final, OLD.spender_rate, OLD.spender_rate_is_final, OLD.payout_rate,
         OLD.payout_bdt, OLD.reserve_funded_bdt, OLD.continuity_subsidy_bdt, OLD.subsidy_capped,
         OLD.credit_transaction_id, OLD.credit_lot_id, OLD.journal_id, OLD.settled_at) THEN
    RAISE EXCEPTION 'credit_liability_settlements: only trued_up_at/true_up_delta_bdt may change (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_liability_settlements_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.credit_liability_settlements
  FOR EACH ROW EXECUTE FUNCTION public.credit_liability_settlements_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- boosts (§6.7): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.boosts (
  id                       uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid        NOT NULL DEFAULT public.current_tenant_id(),
  boost_type_id            uuid        NOT NULL,
  post_id                  uuid,
  store_id                 uuid,
  purchased_by_member_id   uuid        NOT NULL,
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  cost_credits             integer     NOT NULL,
  credit_transaction_id    uuid,
  status_code              text        NOT NULL DEFAULT 'scheduled',
  cancelled_at             timestamptz,
  stopped_at               timestamptz,
  stop_reason_code         text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boosts_pk PRIMARY KEY (id),
  CONSTRAINT boosts_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT boosts_boost_type_id_fk FOREIGN KEY (boost_type_id)
    REFERENCES public.boost_types (id) ON DELETE RESTRICT,
  CONSTRAINT boosts_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT boosts_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT boosts_tenant_id_purchased_by_member_id_fk FOREIGN KEY (tenant_id, purchased_by_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT boosts_tenant_id_credit_transaction_id_fk FOREIGN KEY (tenant_id, credit_transaction_id)
    REFERENCES public.credit_transactions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT boosts_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.boost_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT boosts_stop_reason_code_fk FOREIGN KEY (stop_reason_code)
    REFERENCES public.boost_stop_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT boosts_target_ck CHECK (num_nonnulls(post_id, store_id) = 1),
  CONSTRAINT boosts_ends_at_ck CHECK (ends_at > starts_at),
  CONSTRAINT boosts_cost_credits_ck CHECK (cost_credits >= 0),
  CONSTRAINT boosts_credit_transaction_ck CHECK (credit_transaction_id IS NOT NULL OR cost_credits = 0),
  CONSTRAINT boosts_stopped_at_ck CHECK ((status_code = 'stopped') = (stopped_at IS NOT NULL)),
  CONSTRAINT boosts_stop_reason_ck CHECK ((status_code = 'stopped') = (stop_reason_code IS NOT NULL)),
  -- Composite-FK target (§0.4).
  CONSTRAINT boosts_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- The same boost can't be bought twice for overlapping windows.
  CONSTRAINT boosts_no_overlap_post_excl EXCLUDE USING gist (
    tenant_id WITH =, post_id WITH =, boost_type_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (post_id IS NOT NULL AND status_code IN ('scheduled', 'active')),
  CONSTRAINT boosts_no_overlap_store_excl EXCLUDE USING gist (
    tenant_id WITH =, store_id WITH =, boost_type_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (store_id IS NOT NULL AND status_code IN ('scheduled', 'active'))
);
--> statement-breakpoint
-- Feed builder: which boosts are live now for this placement. Hot query
-- (instructions): (tenant_id, boost_expires_at) — ends_at is that column here.
CREATE INDEX boosts_tenant_type_ends_active_idx ON public.boosts (tenant_id, boost_type_id, ends_at)
  WHERE status_code = 'active';
--> statement-breakpoint
-- Postgres requires partial-index predicates to be IMMUTABLE; now() is only
-- STABLE, so "WHERE ends_at > now()" (as literally asked for) is invalid —
-- status_code = 'active' alone gives the same "currently boosted" filter
-- without a predicate that can't be indexed. The now() comparison belongs
-- in the query, not the index.
CREATE INDEX boosts_tenant_ends_active_idx ON public.boosts (tenant_id, ends_at)
  WHERE status_code = 'active';
--> statement-breakpoint
-- Cross-tenant system job: activate scheduled boosts.
CREATE INDEX boosts_scheduled_idx ON public.boosts (status_code, starts_at)
  WHERE status_code = 'scheduled';
--> statement-breakpoint
-- Cross-tenant system job: expire active boosts.
CREATE INDEX boosts_active_ends_idx ON public.boosts (status_code, ends_at)
  WHERE status_code = 'active';
--> statement-breakpoint
-- "My boosts".
CREATE INDEX boosts_tenant_purchaser_idx ON public.boosts (tenant_id, purchased_by_member_id, id DESC);
--> statement-breakpoint
CREATE TRIGGER boosts_set_updated_at BEFORE UPDATE ON public.boosts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- boost_vouchers (§6.24): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.boost_vouchers (
  id                      uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id               uuid        NOT NULL DEFAULT public.current_tenant_id(),
  user_id                 uuid        NOT NULL,
  source_boost_id         uuid        NOT NULL,
  boost_type_id           uuid        NOT NULL,
  remaining_days          integer     NOT NULL,
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz,
  consumed_by_boost_id    uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boost_vouchers_pk PRIMARY KEY (id),
  CONSTRAINT boost_vouchers_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT boost_vouchers_tenant_id_user_id_fk FOREIGN KEY (user_id, tenant_id)
    REFERENCES public.tenant_members (user_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT boost_vouchers_tenant_id_source_boost_id_fk FOREIGN KEY (tenant_id, source_boost_id)
    REFERENCES public.boosts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT boost_vouchers_tenant_id_consumed_by_boost_id_fk FOREIGN KEY (tenant_id, consumed_by_boost_id)
    REFERENCES public.boosts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT boost_vouchers_boost_type_id_fk FOREIGN KEY (boost_type_id)
    REFERENCES public.boost_types (id) ON DELETE RESTRICT,
  CONSTRAINT boost_vouchers_remaining_days_ck CHECK (remaining_days >= 1),
  CONSTRAINT boost_vouchers_consumed_ck CHECK ((consumed_at IS NULL) = (consumed_by_boost_id IS NULL)),
  -- One voucher per stopped boost; also the tenant_id index.
  CONSTRAINT boost_vouchers_tenant_source_boost_uq UNIQUE (tenant_id, source_boost_id)
);
--> statement-breakpoint
-- "My vouchers" at checkout.
CREATE INDEX boost_vouchers_tenant_user_unconsumed_idx ON public.boost_vouchers (tenant_id, user_id, expires_at)
  WHERE consumed_at IS NULL;
--> statement-breakpoint
-- Expiry reminder job.
CREATE INDEX boost_vouchers_expiry_idx ON public.boost_vouchers (expires_at)
  WHERE consumed_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER boost_vouchers_set_updated_at BEFORE UPDATE ON public.boost_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- can_view_invoice(): plain (not SECURITY DEFINER; see 0006's
-- can_manage_store() precedent). Used only by invoice_lines' RLS below,
-- which is a different table from the ones this queries, so no recursion.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_view_invoice(target_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = target_invoice_id
      AND i.tenant_id = (SELECT public.current_tenant_id())
      AND (
        i.billed_member_id = (SELECT public.current_member_id())
        OR (i.billed_store_id IS NOT NULL AND (SELECT public.can_manage_store(i.billed_store_id)))
        OR (SELECT public.app_is_staff())
      )
  )
$$;
--> statement-breakpoint

-- ============================================================================
-- Closing three deferred FKs from 0003/0006, now that their enums exist.
-- ============================================================================

ALTER TABLE public.tenant_transfers
  ADD CONSTRAINT tenant_transfers_credit_valuation_method_code_fk
    FOREIGN KEY (credit_valuation_method_code) REFERENCES public.credit_valuation_methods (code) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.vat_rates
  ADD CONSTRAINT vat_rates_revenue_stream_code_fk
    FOREIGN KEY (revenue_stream_code) REFERENCES public.revenue_streams (code) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.stores
  ADD CONSTRAINT stores_current_plan_code_fk
    FOREIGN KEY (current_plan_code) REFERENCES public.subscription_plans (code) ON DELETE RESTRICT;


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
        'credit_reasons', 'credit_valuation_methods', 'credit_pool_statuses', 'credit_disposition_outcomes',
        'port_destination_rules', 'closure_refund_statuses', 'liability_settlement_kinds', 'boost_placements',
        'boost_targets', 'boost_statuses', 'boost_stop_reasons', 'subscription_subjects', 'billing_intervals',
        'subscription_statuses', 'invoice_statuses', 'invoice_line_types', 'revenue_streams', 'ad_surfaces',
        'ad_creative_statuses', 'ad_booking_statuses',
        'credit_closure_dispositions', 'credit_wallets', 'credit_packages', 'tenant_credit_packages',
        'boost_types', 'tenant_boost_prices', 'subscription_plans', 'tenant_plan_prices', 'subscriptions',
        'invoices', 'ad_slots', 'ad_inventory', 'ad_creatives', 'ad_bookings', 'ad_daily_stats', 'invoice_lines',
        'credit_transactions', 'credit_lots', 'credit_lot_allocations', 'tenant_credit_liability',
        'platform_credit_pool', 'credit_liability_settlements', 'boosts', 'boost_vouchers'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0006) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'credit_reasons', 'credit_valuation_methods', 'credit_pool_statuses', 'credit_disposition_outcomes',
    'port_destination_rules', 'closure_refund_statuses', 'liability_settlement_kinds', 'boost_placements',
    'boost_targets', 'boost_statuses', 'boost_stop_reasons', 'subscription_subjects', 'billing_intervals',
    'subscription_statuses', 'invoice_statuses', 'invoice_line_types', 'revenue_streams', 'ad_surfaces',
    'ad_creative_statuses', 'ad_booking_statuses'
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

-- ---- credit_wallets: T-ISOLATE base; own (any tenant) + staff read -------

CREATE POLICY credit_wallets_owner_read ON public.credit_wallets
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY credit_wallets_staff_read ON public.credit_wallets
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
-- INSERT only (wallet creation, e.g. with a new membership); no UPDATE policy
-- for any app role — balance only ever moves through credit_apply(), which
-- is not built yet (see header), so there is deliberately no way to move it.
CREATE POLICY credit_wallets_system_insert ON public.credit_wallets
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY credit_wallets_platform_admin ON public.credit_wallets
  FOR SELECT
  USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- credit_transactions: T-ISOLATE base; own (any tenant) + staff read --

CREATE POLICY credit_transactions_owner_read ON public.credit_transactions
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY credit_transactions_staff_read ON public.credit_transactions
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
-- INSERT in the tenant's own context; admin_adjustment additionally requires
-- tenant_admin. No UPDATE/DELETE policy (the immutability trigger backs
-- this up regardless of grants).
CREATE POLICY credit_transactions_tenant_insert ON public.credit_transactions
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (reason_code <> 'admin_adjustment' OR (SELECT public.app_is_tenant_admin()))
  );
--> statement-breakpoint
CREATE POLICY credit_transactions_platform_admin ON public.credit_transactions
  FOR SELECT
  USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- credit_packages (G-REFERENCE) / tenant_credit_packages (T-PUBLIC-READ)

CREATE POLICY credit_packages_read_all ON public.credit_packages FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY credit_packages_platform_admin ON public.credit_packages
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY tenant_credit_packages_public_read ON public.tenant_credit_packages
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_enabled);
--> statement-breakpoint
CREATE POLICY tenant_credit_packages_admin_write ON public.tenant_credit_packages
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_credit_packages_platform_admin ON public.tenant_credit_packages
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- boost_types (G-REFERENCE) / tenant_boost_prices (T-PUBLIC-READ) -----

CREATE POLICY boost_types_read_all ON public.boost_types FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY boost_types_platform_admin ON public.boost_types
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY tenant_boost_prices_public_read ON public.tenant_boost_prices
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_enabled);
--> statement-breakpoint
CREATE POLICY tenant_boost_prices_admin_write ON public.tenant_boost_prices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_boost_prices_platform_admin ON public.tenant_boost_prices
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- boosts: T-PUBLIC-READ (active) + purchaser (own) + staff ------------

CREATE POLICY boosts_public_read ON public.boosts
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND status_code = 'active');
--> statement-breakpoint
CREATE POLICY boosts_purchaser_access ON public.boosts
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND purchased_by_member_id = (SELECT public.current_member_id())
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND purchased_by_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY boosts_staff_access ON public.boosts
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY boosts_platform_admin ON public.boosts
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- subscription_plans (G-REFERENCE) / tenant_plan_prices (T-PUBLIC-READ)

CREATE POLICY subscription_plans_read_all ON public.subscription_plans FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY subscription_plans_platform_admin ON public.subscription_plans
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY tenant_plan_prices_public_read ON public.tenant_plan_prices
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_enabled);
--> statement-breakpoint
CREATE POLICY tenant_plan_prices_admin_write ON public.tenant_plan_prices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_plan_prices_platform_admin ON public.tenant_plan_prices
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- subscriptions: T-ISOLATE; subscriber (member or store manager) -----

CREATE POLICY subscriptions_subscriber_read ON public.subscriptions
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      member_id = (SELECT public.current_member_id())
      OR (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
    )
  );
--> statement-breakpoint
-- A subscriber may only toggle cancel_at_period_end; the rest is service/system.
CREATE POLICY subscriptions_subscriber_cancel ON public.subscriptions
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      member_id = (SELECT public.current_member_id())
      OR (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
    )
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      member_id = (SELECT public.current_member_id())
      OR (store_id IS NOT NULL AND (SELECT public.can_manage_store(store_id)))
    )
  );
--> statement-breakpoint
CREATE POLICY subscriptions_staff_access ON public.subscriptions
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY subscriptions_system_write ON public.subscriptions
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY subscriptions_platform_admin ON public.subscriptions
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- invoices: T-ISOLATE; billed member/store manager + staff -----------

CREATE POLICY invoices_billed_read ON public.invoices
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (
      billed_member_id = (SELECT public.current_member_id())
      OR (billed_store_id IS NOT NULL AND (SELECT public.can_manage_store(billed_store_id)))
    )
  );
--> statement-breakpoint
CREATE POLICY invoices_staff_access ON public.invoices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY invoices_system_write ON public.invoices
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY invoices_platform_admin ON public.invoices
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- invoice_lines: follows the parent invoice via can_view_invoice() ----

CREATE POLICY invoice_lines_read ON public.invoice_lines
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.can_view_invoice(invoice_id)));
--> statement-breakpoint
CREATE POLICY invoice_lines_staff_write ON public.invoice_lines
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY invoice_lines_system_write ON public.invoice_lines
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY invoice_lines_platform_admin ON public.invoice_lines
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- ad_slots (G-REFERENCE) / ad_inventory (T-PUBLIC-READ) ---------------

CREATE POLICY ad_slots_read_all ON public.ad_slots FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY ad_slots_platform_admin ON public.ad_slots
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

CREATE POLICY ad_inventory_public_read ON public.ad_inventory
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()) AND is_enabled);
--> statement-breakpoint
CREATE POLICY ad_inventory_admin_write ON public.ad_inventory
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY ad_inventory_platform_admin ON public.ad_inventory
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- ad_creatives: T-ISOLATE; advertiser CRUD own; staff all -------------

CREATE POLICY ad_creatives_advertiser_access ON public.ad_creatives
  FOR ALL
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND advertiser_member_id = (SELECT public.current_member_id())
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND advertiser_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY ad_creatives_staff_access ON public.ad_creatives
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY ad_creatives_platform_admin ON public.ad_creatives
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- ad_bookings: T-ISOLATE; advertiser (own) + staff --------------------

CREATE POLICY ad_bookings_advertiser_read ON public.ad_bookings
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND advertiser_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY ad_bookings_advertiser_insert ON public.ad_bookings
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND advertiser_member_id = (SELECT public.current_member_id())
  );
--> statement-breakpoint
CREATE POLICY ad_bookings_staff_access ON public.ad_bookings
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY ad_bookings_system_write ON public.ad_bookings
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY ad_bookings_platform_admin ON public.ad_bookings
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- ad_daily_stats: T-ISOLATE; booking's advertiser + staff read --------

CREATE POLICY ad_daily_stats_advertiser_read ON public.ad_daily_stats
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.ad_bookings b
      WHERE b.id = ad_daily_stats.ad_booking_id AND b.advertiser_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY ad_daily_stats_staff_read ON public.ad_daily_stats
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY ad_daily_stats_system_write ON public.ad_daily_stats
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY ad_daily_stats_platform_admin ON public.ad_daily_stats
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- credit_lots / credit_lot_allocations: own (any tenant) + staff -----

CREATE POLICY credit_lots_owner_read ON public.credit_lots
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY credit_lots_staff_read ON public.credit_lots
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY credit_lots_platform_admin ON public.credit_lots
  FOR SELECT
  USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint
-- No INSERT policy for any app role yet: lots are only ever written inside
-- credit_apply(), which is not built (see header).

CREATE POLICY credit_lot_allocations_owner_read ON public.credit_lot_allocations
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.credit_transactions t
      WHERE t.id = credit_lot_allocations.credit_transaction_id AND t.user_id = (SELECT public.current_user_id())
    )
  );
--> statement-breakpoint
CREATE POLICY credit_lot_allocations_staff_read ON public.credit_lot_allocations
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY credit_lot_allocations_platform_admin ON public.credit_lot_allocations
  FOR SELECT
  USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- tenant_credit_liability: staff/platform/system SELECT only ---------

CREATE POLICY tenant_credit_liability_staff_read ON public.tenant_credit_liability
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_credit_liability_platform_read ON public.tenant_credit_liability
  FOR SELECT
  USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
-- No INSERT/UPDATE/DELETE policy for any app role: only the (not yet built)
-- SECURITY DEFINER sync trigger and provisioning touch this table.

-- ---- platform_credit_pool: G-OWNER SELECT; system writes ----------------

CREATE POLICY platform_credit_pool_owner_read ON public.platform_credit_pool
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY platform_credit_pool_platform_read ON public.platform_credit_pool
  FOR SELECT
  USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY platform_credit_pool_system_write ON public.platform_credit_pool
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- credit_closure_dispositions: G-OWNER SELECT; system/platform write -

CREATE POLICY credit_closure_dispositions_owner_read ON public.credit_closure_dispositions
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY credit_closure_dispositions_platform_read ON public.credit_closure_dispositions
  FOR SELECT
  USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY credit_closure_dispositions_system_write ON public.credit_closure_dispositions
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY credit_closure_dispositions_platform_admin_write ON public.credit_closure_dispositions
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- credit_liability_settlements: platform/finance all; earning tenant -

CREATE POLICY credit_liability_settlements_platform_read ON public.credit_liability_settlements
  FOR SELECT
  USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY credit_liability_settlements_earning_tenant_read ON public.credit_liability_settlements
  FOR SELECT
  USING (to_tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
-- FOR ALL, not FOR UPDATE: an UPDATE-only policy has no matching SELECT
-- policy for 'system', and Postgres requires a row to be SELECT-visible
-- before an UPDATE can touch it — a system UPDATE would silently affect 0
-- rows otherwise. FOR ALL closes that gap; it doesn't newly permit INSERT/
-- DELETE, since ae_app is only GRANTed SELECT, UPDATE on this table (below).
CREATE POLICY credit_liability_settlements_system_true_up ON public.credit_liability_settlements
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- boost_vouchers: own + staff read; system insert; owner redeems -----

CREATE POLICY boost_vouchers_owner_read ON public.boost_vouchers
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
  );
--> statement-breakpoint
CREATE POLICY boost_vouchers_staff_read ON public.boost_vouchers
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY boost_vouchers_system_insert ON public.boost_vouchers
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
-- Redeem: the owner may move consumed_at/consumed_by_boost_id, but only
-- forward (unconsumed -> consumed), and only their own, unexpired voucher.
CREATE POLICY boost_vouchers_owner_redeem ON public.boost_vouchers
  FOR UPDATE
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
    AND consumed_at IS NULL
    AND expires_at > now()
  )
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND user_id = (SELECT public.current_user_id())
  );
--> statement-breakpoint
CREATE POLICY boost_vouchers_platform_admin ON public.boost_vouchers
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));



-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.credit_reasons, public.credit_valuation_methods, public.credit_pool_statuses,
  public.credit_disposition_outcomes, public.port_destination_rules, public.closure_refund_statuses,
  public.liability_settlement_kinds, public.boost_placements, public.boost_targets, public.boost_statuses,
  public.boost_stop_reasons, public.subscription_subjects, public.billing_intervals, public.subscription_statuses,
  public.invoice_statuses, public.invoice_line_types, public.revenue_streams, public.ad_surfaces,
  public.ad_creative_statuses, public.ad_booking_statuses
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.credit_reasons, public.credit_valuation_methods, public.credit_pool_statuses,
  public.credit_disposition_outcomes, public.port_destination_rules, public.closure_refund_statuses,
  public.liability_settlement_kinds, public.boost_placements, public.boost_targets, public.boost_statuses,
  public.boost_stop_reasons, public.subscription_subjects, public.billing_intervals, public.subscription_statuses,
  public.invoice_statuses, public.invoice_line_types, public.revenue_streams, public.ad_surfaces,
  public.ad_creative_statuses, public.ad_booking_statuses
TO ae_app;
--> statement-breakpoint

-- No UPDATE/DELETE: balance only ever moves through credit_apply() (not
-- built yet, see header).
GRANT SELECT, INSERT ON public.credit_wallets TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.credit_transactions TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.credit_packages TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_credit_packages TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.boost_types TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_boost_prices TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.boosts TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.subscription_plans TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_plan_prices TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.subscriptions TO ae_app;
--> statement-breakpoint
-- Drafts may be deleted directly; the trigger blocks it once issued.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_lines TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ad_slots TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ad_inventory TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ad_creatives TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ad_bookings TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ad_daily_stats TO ae_app;
--> statement-breakpoint
-- SELECT only: written only inside credit_apply() (not built yet).
GRANT SELECT ON public.credit_lots TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.credit_lot_allocations TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.tenant_credit_liability TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.platform_credit_pool TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.credit_closure_dispositions TO ae_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.credit_liability_settlements TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.boost_vouchers TO ae_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.can_view_invoice(uuid) TO ae_app;

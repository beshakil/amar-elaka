-- 0012_operations
--
-- Operations domain (docs/specs/schema.md §11): field agents and their
-- geotagged visits and commissions, activity logs, support tickets and
-- their thread, the transactional outbox, legal holds, and agent cash
-- remittances. audit_logs itself was already built in 0001/0002. Runs as
-- ae_migrator; RLS and grants are in this same file, as in 0003-0011.
--
-- Closes deferred FKs that already point here:
--   - place_claims.agent_visit_id -> agent_visits (0005)
--   - media_attachments.agent_visit_id / ticket_message_id -> agent_visits /
--     ticket_messages (0005)
--   - business_verifications.agent_visit_id -> agent_visits (0010)
--   - moderation_actions.legal_hold_id -> legal_holds (0010)
--   - payments.collected_by_agent_id / agent_remittance_id -> field_agents /
--     agent_cash_remittances (0008)
--
-- Also closes four FKs that 0010/0011 documented as deferred-to-0012 but
-- never actually added, caught while auditing this migration's own deferred
-- list: media_attachments.review_id (0010), business_verification_id
-- (0010, plus the tenant_id_id_uq that table was missing), notice_id
-- (0011), lost_found_item_id (0011). All four target tables have existed
-- since their own migration; nothing about 0012 was needed to close them,
-- they were simply skipped. Fixed here rather than left open further.
--
-- New setting this migration (CLAUDE.md rule 9): agent_visit_edit_window_hours
-- (default 24), backing agent_visits' "no edits after the window" trigger —
-- seed row + SettingsService registry entry, same change.
--
-- ============================================================================
-- SCOPE — as with 0007-0011: full DDL/CHECKs/indexes/RLS for every table,
-- every self-contained trigger, and the two SECURITY DEFINER helpers the
-- spec names for this domain (is_my_field_agent, legal_hold_blocks). NOT
-- built here, and why:
--   - The generic audit_row_change() trigger + attaching it to the ~13
--     sensitive tables §11.4 lists: a separate cross-cutting pass, not this
--     migration's own tables. audit_logs works today via explicit
--     service-layer writes; the automatic trigger is still deferred.
--   - outbox_events gets its full table/RLS/grants, but no previously
--     written trigger (e.g. 0010's bans_sync_membership_cache()) is
--     retrofitted to emit into it yet — the relay/consumer side isn't built
--     either, so there would be nothing to observe the emission.
--   - support_tickets.ticket_number generation: service-layer, same as
--     invoices.invoice_number (0007) — the column is just `text not null`.
--   - Scheduled jobs the indexes below are annotated for (activity_logs /
--     outbox_events retention drops+deletes, agent_cash_max_hold_hours
--     alerts, business_verifications expiry): cron, not schema.
--   - scrub_*/purge_*/anonymize_* functions that would call
--     legal_hold_blocks(): none exist yet (§13.31's scrub_post() is a
--     future pass); the helper is built now because the spec ties it
--     directly to legal_holds existing, and every future purge/scrub
--     function is required to call it from day one.
-- ============================================================================

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.remittance_methods (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remittance_methods_pk PRIMARY KEY (code), CONSTRAINT remittance_methods_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER remittance_methods_set_updated_at BEFORE UPDATE ON public.remittance_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.remittance_methods (code, label_key, sort_order) VALUES
  ('cash_handover', 'enum.remittance_methods.cash_handover', 10),
  ('bkash', 'enum.remittance_methods.bkash', 20),
  ('nagad', 'enum.remittance_methods.nagad', 30),
  ('bank_deposit', 'enum.remittance_methods.bank_deposit', 40);
--> statement-breakpoint

CREATE TABLE public.remittance_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remittance_statuses_pk PRIMARY KEY (code), CONSTRAINT remittance_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER remittance_statuses_set_updated_at BEFORE UPDATE ON public.remittance_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.remittance_statuses (code, label_key, sort_order) VALUES
  ('submitted', 'enum.remittance_statuses.submitted', 10),
  ('confirmed', 'enum.remittance_statuses.confirmed', 20),
  ('disputed', 'enum.remittance_statuses.disputed', 30),
  ('rejected', 'enum.remittance_statuses.rejected', 40);
--> statement-breakpoint

CREATE TABLE public.legal_hold_subject_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_hold_subject_types_pk PRIMARY KEY (code), CONSTRAINT legal_hold_subject_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER legal_hold_subject_types_set_updated_at BEFORE UPDATE ON public.legal_hold_subject_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.legal_hold_subject_types (code, label_key, sort_order) VALUES
  ('post', 'enum.legal_hold_subject_types.post', 10),
  ('media_asset', 'enum.legal_hold_subject_types.media_asset', 20),
  ('user', 'enum.legal_hold_subject_types.user', 30),
  ('conversation', 'enum.legal_hold_subject_types.conversation', 40),
  ('message', 'enum.legal_hold_subject_types.message', 50),
  ('store', 'enum.legal_hold_subject_types.store', 60);
--> statement-breakpoint

CREATE TABLE public.agent_employment_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_employment_types_pk PRIMARY KEY (code), CONSTRAINT agent_employment_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER agent_employment_types_set_updated_at BEFORE UPDATE ON public.agent_employment_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.agent_employment_types (code, label_key, sort_order) VALUES
  ('commission_only', 'enum.agent_employment_types.commission_only', 10),
  ('salaried', 'enum.agent_employment_types.salaried', 20),
  ('volunteer', 'enum.agent_employment_types.volunteer', 30);
--> statement-breakpoint

CREATE TABLE public.agent_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_statuses_pk PRIMARY KEY (code), CONSTRAINT agent_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER agent_statuses_set_updated_at BEFORE UPDATE ON public.agent_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.agent_statuses (code, label_key, sort_order) VALUES
  ('active', 'enum.agent_statuses.active', 10),
  ('suspended', 'enum.agent_statuses.suspended', 20),
  ('terminated', 'enum.agent_statuses.terminated', 30);
--> statement-breakpoint

CREATE TABLE public.visit_purposes (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_purposes_pk PRIMARY KEY (code), CONSTRAINT visit_purposes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER visit_purposes_set_updated_at BEFORE UPDATE ON public.visit_purposes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.visit_purposes (code, label_key, sort_order) VALUES
  ('onboarding', 'enum.visit_purposes.onboarding', 10),
  ('verification', 'enum.visit_purposes.verification', 20),
  ('follow_up', 'enum.visit_purposes.follow_up', 30),
  ('data_collection', 'enum.visit_purposes.data_collection', 40),
  ('cash_collection', 'enum.visit_purposes.cash_collection', 50);
--> statement-breakpoint

CREATE TABLE public.visit_outcomes (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_outcomes_pk PRIMARY KEY (code), CONSTRAINT visit_outcomes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER visit_outcomes_set_updated_at BEFORE UPDATE ON public.visit_outcomes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.visit_outcomes (code, label_key, sort_order) VALUES
  ('onboarded', 'enum.visit_outcomes.onboarded', 10),
  ('verified', 'enum.visit_outcomes.verified', 20),
  ('not_interested', 'enum.visit_outcomes.not_interested', 30),
  ('closed_down', 'enum.visit_outcomes.closed_down', 40),
  ('revisit_needed', 'enum.visit_outcomes.revisit_needed', 50);
--> statement-breakpoint

CREATE TABLE public.commission_sources (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_sources_pk PRIMARY KEY (code), CONSTRAINT commission_sources_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER commission_sources_set_updated_at BEFORE UPDATE ON public.commission_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.commission_sources (code, label_key, sort_order) VALUES
  ('store_onboarded', 'enum.commission_sources.store_onboarded', 10),
  ('subscription_sold', 'enum.commission_sources.subscription_sold', 20),
  ('credits_sold', 'enum.commission_sources.credits_sold', 30),
  ('ad_sold', 'enum.commission_sources.ad_sold', 40),
  ('verification_completed', 'enum.commission_sources.verification_completed', 50);
--> statement-breakpoint

CREATE TABLE public.commission_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_statuses_pk PRIMARY KEY (code), CONSTRAINT commission_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER commission_statuses_set_updated_at BEFORE UPDATE ON public.commission_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.commission_statuses (code, label_key, sort_order) VALUES
  ('accrued', 'enum.commission_statuses.accrued', 10),
  ('approved', 'enum.commission_statuses.approved', 20),
  ('paid', 'enum.commission_statuses.paid', 30),
  ('reversed', 'enum.commission_statuses.reversed', 40),
  ('rejected', 'enum.commission_statuses.rejected', 50);
--> statement-breakpoint

CREATE TABLE public.activity_event_types (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_event_types_pk PRIMARY KEY (code), CONSTRAINT activity_event_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER activity_event_types_set_updated_at BEFORE UPDATE ON public.activity_event_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.activity_event_types (code, label_key, sort_order) VALUES
  ('post_viewed', 'enum.activity_event_types.post_viewed', 10),
  ('place_viewed', 'enum.activity_event_types.place_viewed', 20),
  ('search_performed', 'enum.activity_event_types.search_performed', 30),
  ('category_opened', 'enum.activity_event_types.category_opened', 40),
  ('notice_opened', 'enum.activity_event_types.notice_opened', 50);
--> statement-breakpoint

CREATE TABLE public.ticket_categories (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_categories_pk PRIMARY KEY (code), CONSTRAINT ticket_categories_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ticket_categories_set_updated_at BEFORE UPDATE ON public.ticket_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ticket_categories (code, label_key, sort_order) VALUES
  ('payment_issue', 'enum.ticket_categories.payment_issue', 10),
  ('account', 'enum.ticket_categories.account', 20),
  ('moderation_appeal', 'enum.ticket_categories.moderation_appeal', 30),
  ('scam_help', 'enum.ticket_categories.scam_help', 40),
  ('category_request', 'enum.ticket_categories.category_request', 50),
  ('technical', 'enum.ticket_categories.technical', 60),
  ('other', 'enum.ticket_categories.other', 70);
--> statement-breakpoint

CREATE TABLE public.ticket_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_statuses_pk PRIMARY KEY (code), CONSTRAINT ticket_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ticket_statuses_set_updated_at BEFORE UPDATE ON public.ticket_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ticket_statuses (code, label_key, sort_order) VALUES
  ('open', 'enum.ticket_statuses.open', 10),
  ('pending_requester', 'enum.ticket_statuses.pending_requester', 20),
  ('pending_staff', 'enum.ticket_statuses.pending_staff', 30),
  ('escalated', 'enum.ticket_statuses.escalated', 40),
  ('resolved', 'enum.ticket_statuses.resolved', 50),
  ('closed', 'enum.ticket_statuses.closed', 60);
--> statement-breakpoint

CREATE TABLE public.ticket_priorities (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_priorities_pk PRIMARY KEY (code), CONSTRAINT ticket_priorities_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ticket_priorities_set_updated_at BEFORE UPDATE ON public.ticket_priorities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ticket_priorities (code, label_key, sort_order) VALUES
  ('low', 'enum.ticket_priorities.low', 10),
  ('normal', 'enum.ticket_priorities.normal', 20),
  ('high', 'enum.ticket_priorities.high', 30),
  ('urgent', 'enum.ticket_priorities.urgent', 40);
--> statement-breakpoint

-- ============================================================================
-- field_agents (§11.1): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.field_agents (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  member_id                uuid          NOT NULL,
  agent_code               text          NOT NULL,
  employment_type_code     text          NOT NULL,
  default_commission_pct   numeric(5,2),
  primary_geo_area_id      uuid,
  cash_limit               numeric(12,2) NOT NULL DEFAULT 0,
  status_code              text          NOT NULL DEFAULT 'active',
  joined_on                date          NOT NULL,
  terminated_on            date,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT field_agents_pk PRIMARY KEY (id),
  CONSTRAINT field_agents_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT field_agents_tenant_id_member_id_fk FOREIGN KEY (tenant_id, member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_agents_employment_type_code_fk FOREIGN KEY (employment_type_code)
    REFERENCES public.agent_employment_types (code) ON DELETE RESTRICT,
  CONSTRAINT field_agents_primary_geo_area_id_fk FOREIGN KEY (primary_geo_area_id)
    REFERENCES public.geo_areas (id) ON DELETE RESTRICT,
  CONSTRAINT field_agents_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.agent_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT field_agents_default_commission_pct_ck CHECK (default_commission_pct BETWEEN 0 AND 100),
  CONSTRAINT field_agents_cash_limit_ck CHECK (cash_limit >= 0),
  -- Composite-FK target (§0.4).
  CONSTRAINT field_agents_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX field_agents_tenant_id_member_id_uq ON public.field_agents (tenant_id, member_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX field_agents_tenant_id_agent_code_uq ON public.field_agents (tenant_id, agent_code);
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX field_agents_primary_geo_area_id_idx ON public.field_agents (primary_geo_area_id)
  WHERE primary_geo_area_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER field_agents_set_updated_at BEFORE UPDATE ON public.field_agents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- is_my_field_agent(): NOT SECURITY DEFINER — field_agents already lets an
-- agent SELECT their own row, so this only resolves the caller's own facts.
CREATE OR REPLACE FUNCTION public.is_my_field_agent(target_field_agent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.field_agents fa
    WHERE fa.id = target_field_agent_id
      AND fa.tenant_id = (SELECT public.current_tenant_id())
      AND fa.member_id = (SELECT public.current_member_id())
  )
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.is_my_field_agent(uuid) IS
  'True when the caller is the field agent behind this id. Not SECURITY DEFINER (see comment above) — only ever resolves the caller''s own facts, never another member''s.';
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_my_field_agent(uuid) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- agent_visits (§11.2): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.agent_visits (
  id                        uuid                     NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                 uuid                     NOT NULL DEFAULT public.current_tenant_id(),
  field_agent_id            uuid                     NOT NULL,
  place_id                  uuid,
  store_id                  uuid,
  purpose_code              text                     NOT NULL,
  outcome_code              text                     NOT NULL,
  visited_at                timestamptz              NOT NULL,
  check_in_location         geography(Point, 4326)   NOT NULL,
  check_in_accuracy_m       integer,
  distance_from_target_m    integer,
  notes                     text,
  client_visit_id           text                     NOT NULL,
  created_at                timestamptz              NOT NULL DEFAULT now(),
  updated_at                timestamptz              NOT NULL DEFAULT now(),
  CONSTRAINT agent_visits_pk PRIMARY KEY (id),
  CONSTRAINT agent_visits_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT agent_visits_tenant_id_field_agent_id_fk FOREIGN KEY (tenant_id, field_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_visits_tenant_id_place_id_fk FOREIGN KEY (tenant_id, place_id)
    REFERENCES public.places (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT agent_visits_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT agent_visits_purpose_code_fk FOREIGN KEY (purpose_code)
    REFERENCES public.visit_purposes (code) ON DELETE RESTRICT,
  CONSTRAINT agent_visits_outcome_code_fk FOREIGN KEY (outcome_code)
    REFERENCES public.visit_outcomes (code) ON DELETE RESTRICT,
  CONSTRAINT agent_visits_check_in_accuracy_m_ck CHECK (check_in_accuracy_m IS NULL OR check_in_accuracy_m >= 0),
  CONSTRAINT agent_visits_distance_from_target_m_ck CHECK (distance_from_target_m IS NULL OR distance_from_target_m >= 0),
  -- Composite-FK target (§0.4).
  CONSTRAINT agent_visits_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Idempotent offline sync.
CREATE UNIQUE INDEX agent_visits_tenant_agent_client_uq ON public.agent_visits (tenant_id, field_agent_id, client_visit_id);
--> statement-breakpoint
-- Agent activity report.
CREATE INDEX agent_visits_tenant_agent_visited_idx ON public.agent_visits (tenant_id, field_agent_id, visited_at DESC);
--> statement-breakpoint
-- Place visit history.
CREATE INDEX agent_visits_tenant_place_visited_idx ON public.agent_visits (tenant_id, place_id, visited_at DESC)
  WHERE place_id IS NOT NULL;
--> statement-breakpoint
-- Audit rule; also fraud review ("many check-ins from the same spot").
CREATE INDEX agent_visits_check_in_location_gix ON public.agent_visits USING gist (check_in_location);
--> statement-breakpoint
CREATE TRIGGER agent_visits_set_updated_at BEFORE UPDATE ON public.agent_visits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- distance_from_target_m: computed on insert against the target's location
-- (a large distance is a fraud signal, per spec). NULL when neither place
-- nor store is set, or the store has no location on file.
CREATE OR REPLACE FUNCTION public.agent_visits_compute_distance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_location geography(Point, 4326);
BEGIN
  IF NEW.place_id IS NOT NULL THEN
    SELECT location INTO target_location FROM public.places
    WHERE tenant_id = NEW.tenant_id AND id = NEW.place_id;
  ELSIF NEW.store_id IS NOT NULL THEN
    SELECT location INTO target_location FROM public.stores
    WHERE tenant_id = NEW.tenant_id AND id = NEW.store_id;
  END IF;
  IF target_location IS NOT NULL THEN
    NEW.distance_from_target_m := round(public.st_distance(NEW.check_in_location, target_location));
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agent_visits_a_compute_distance BEFORE INSERT ON public.agent_visits
  FOR EACH ROW EXECUTE FUNCTION public.agent_visits_compute_distance();
--> statement-breakpoint

-- Proof-of-visit rows lock agent_visit_edit_window_hours after creation
-- (setting, §2.16; default 24) to protect GPS-proof integrity — read
-- directly from platform_settings, not hardcoded (CLAUDE.md rule 9).
CREATE OR REPLACE FUNCTION public.agent_visits_lock_after_edit_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  window_hours integer;
BEGIN
  SELECT (value #>> '{}')::integer INTO window_hours
  FROM public.platform_settings WHERE key = 'agent_visit_edit_window_hours';
  IF OLD.created_at < now() - make_interval(hours => coalesce(window_hours, 24)) THEN
    RAISE EXCEPTION 'agent_visits: proof-of-visit rows are locked % hours after creation (id %)',
      coalesce(window_hours, 24), OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agent_visits_b_lock_after_edit_window BEFORE UPDATE ON public.agent_visits
  FOR EACH ROW EXECUTE FUNCTION public.agent_visits_lock_after_edit_window();
--> statement-breakpoint

-- ============================================================================
-- agent_commissions (§11.3): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.agent_commissions (
  id                        uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                 uuid          NOT NULL DEFAULT public.current_tenant_id(),
  field_agent_id            uuid          NOT NULL,
  source_code               text          NOT NULL,
  payment_id                uuid,
  store_id                  uuid,
  agent_visit_id            uuid,
  basis_amount              numeric(12,2),
  rate_pct                  numeric(5,2),
  amount                    numeric(12,2) NOT NULL,
  reverses_commission_id    uuid,
  status_code               text          NOT NULL DEFAULT 'accrued',
  approved_by_user_id       uuid,
  approved_at               timestamptz,
  paid_at                   timestamptz,
  paid_reference             text,
  idempotency_key            text          NOT NULL,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT agent_commissions_pk PRIMARY KEY (id),
  CONSTRAINT agent_commissions_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_tenant_id_field_agent_id_fk FOREIGN KEY (tenant_id, field_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_tenant_id_payment_id_fk FOREIGN KEY (tenant_id, payment_id)
    REFERENCES public.payments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_tenant_id_store_id_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES public.stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_tenant_id_agent_visit_id_fk FOREIGN KEY (tenant_id, agent_visit_id)
    REFERENCES public.agent_visits (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_tenant_id_reverses_commission_id_fk FOREIGN KEY (tenant_id, reverses_commission_id)
    REFERENCES public.agent_commissions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT agent_commissions_source_code_fk FOREIGN KEY (source_code)
    REFERENCES public.commission_sources (code) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.commission_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT agent_commissions_amount_ck CHECK (amount <> 0),
  -- Composite-FK target (§0.4), including the self-reference above.
  CONSTRAINT agent_commissions_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_commissions_tenant_idempotency_uq ON public.agent_commissions (tenant_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_commissions_tenant_reverses_uq ON public.agent_commissions (tenant_id, reverses_commission_id)
  WHERE reverses_commission_id IS NOT NULL;
--> statement-breakpoint
-- Agent earnings screen, payout batch.
CREATE INDEX agent_commissions_tenant_agent_status_idx ON public.agent_commissions (tenant_id, field_agent_id, status_code);
--> statement-breakpoint
-- Refund -> clawback lookup.
CREATE INDEX agent_commissions_payment_id_idx ON public.agent_commissions (payment_id)
  WHERE payment_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER agent_commissions_set_updated_at BEFORE UPDATE ON public.agent_commissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- activity_logs (§11.5): TENANT-SCOPED, monthly range partitions,
-- retention activity_log_retention_days (default 90) by dropping partitions
-- (scheduled job, not built here).
-- ============================================================================

CREATE TABLE public.activity_logs (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  member_id             uuid,       -- no FK (volume; survives member deletion)
  anon_session_hash     text,
  event_type_code       text        NOT NULL,
  entity_table          text,
  entity_id             uuid,       -- no FK
  properties            jsonb       NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_logs_pk PRIMARY KEY (id, occurred_at),
  CONSTRAINT activity_logs_event_type_code_fk FOREIGN KEY (event_type_code)
    REFERENCES public.activity_event_types (code) ON DELETE RESTRICT,
  CONSTRAINT activity_logs_properties_ck CHECK (jsonb_typeof(properties) = 'object')
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
-- "Recently viewed".
CREATE INDEX activity_logs_tenant_member_occurred_idx ON public.activity_logs (tenant_id, member_id, occurred_at DESC)
  WHERE member_id IS NOT NULL;
--> statement-breakpoint
-- Rollups.
CREATE INDEX activity_logs_occurred_at_brin_idx ON public.activity_logs USING brin (occurred_at);
--> statement-breakpoint
CREATE TRIGGER activity_logs_set_updated_at BEFORE UPDATE ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ensure_activity_log_partitions(): same shape as 0001/0002's
-- ensure_audit_log_partitions(), built RLS-aware from the start since RLS
-- already exists by this migration. SECURITY DEFINER so a scheduled job
-- running as ae_app can create partitions without CREATE on the schema;
-- partitions end up owned by ae_migrator. Each partition gets its own
-- ENABLE+FORCE RLS and a deny-all "no direct access" policy so a query
-- naming the partition table directly (bypassing the parent's pruning)
-- still goes nowhere; the parent table's policies are what actually apply.
CREATE OR REPLACE FUNCTION public.ensure_activity_log_partitions(from_month date, months integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  month_start date;
  partition_name text;
  created integer := 0;
BEGIN
  IF months < 1 THEN
    RAISE EXCEPTION 'months must be >= 1 (got %)', months;
  END IF;
  FOR offset_months IN 0 .. months - 1 LOOP
    month_start := (date_trunc('month', from_month) + make_interval(months => offset_months))::date;
    partition_name := format('activity_logs_y%sm%s', to_char(month_start, 'YYYY'), to_char(month_start, 'MM'));
    IF to_regclass(format('public.%I', partition_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.activity_logs FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        (month_start::timestamp AT TIME ZONE 'Asia/Dhaka'),
        ((month_start + interval '1 month')::timestamp AT TIME ZONE 'Asia/Dhaka')
      );
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', partition_name);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (false) WITH CHECK (false)',
                     partition_name || '_no_direct_access', partition_name);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ensure_activity_log_partitions(date, integer) TO ae_app;
--> statement-breakpoint
-- Current Dhaka month plus the next three (same window as audit_logs).
SELECT public.ensure_activity_log_partitions((now() AT TIME ZONE 'Asia/Dhaka')::date, 4);
--> statement-breakpoint

-- ============================================================================
-- support_tickets (§11.6): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.support_tickets (
  id                        uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                 uuid        NOT NULL DEFAULT public.current_tenant_id(),
  ticket_number              text        NOT NULL,
  requester_member_id        uuid        NOT NULL,
  category_code              text        NOT NULL,
  subject                   text        NOT NULL,
  status_code                text        NOT NULL DEFAULT 'open',
  priority_code               text        NOT NULL DEFAULT 'normal',
  assigned_to_user_id         uuid,
  payment_id                 uuid,
  post_id                    uuid,
  report_id                  uuid,
  first_response_due_at       timestamptz,
  first_responded_at          timestamptz,
  escalated_at               timestamptz,
  resolved_at                 timestamptz,
  closed_at                  timestamptz,
  satisfaction_rating         smallint,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_pk PRIMARY KEY (id),
  CONSTRAINT support_tickets_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT support_tickets_tenant_id_requester_member_id_fk FOREIGN KEY (tenant_id, requester_member_id)
    REFERENCES public.tenant_members (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT support_tickets_assigned_to_user_id_fk FOREIGN KEY (assigned_to_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT support_tickets_tenant_id_payment_id_fk FOREIGN KEY (tenant_id, payment_id)
    REFERENCES public.payments (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT support_tickets_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT support_tickets_tenant_id_report_id_fk FOREIGN KEY (tenant_id, report_id)
    REFERENCES public.reports (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT support_tickets_category_code_fk FOREIGN KEY (category_code)
    REFERENCES public.ticket_categories (code) ON DELETE RESTRICT,
  CONSTRAINT support_tickets_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.ticket_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT support_tickets_priority_code_fk FOREIGN KEY (priority_code)
    REFERENCES public.ticket_priorities (code) ON DELETE RESTRICT,
  CONSTRAINT support_tickets_satisfaction_rating_ck CHECK (satisfaction_rating BETWEEN 1 AND 5),
  -- Composite-FK target (§0.4).
  CONSTRAINT support_tickets_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX support_tickets_tenant_number_uq ON public.support_tickets (tenant_id, ticket_number);
--> statement-breakpoint
-- Tenant support queue.
CREATE INDEX support_tickets_tenant_queue_idx ON public.support_tickets (tenant_id, status_code, priority_code, id)
  WHERE status_code NOT IN ('resolved', 'closed');
--> statement-breakpoint
-- "My tickets".
CREATE INDEX support_tickets_tenant_requester_idx ON public.support_tickets (tenant_id, requester_member_id, id DESC);
--> statement-breakpoint
-- Cross-tenant platform support queue.
CREATE INDEX support_tickets_escalated_idx ON public.support_tickets (escalated_at)
  WHERE status_code = 'escalated';
--> statement-breakpoint
-- SLA breach alerts.
CREATE INDEX support_tickets_sla_idx ON public.support_tickets (first_response_due_at)
  WHERE first_responded_at IS NULL AND status_code = 'open';
--> statement-breakpoint
CREATE TRIGGER support_tickets_set_updated_at BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- ticket_messages (§11.7): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.ticket_messages (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT public.current_tenant_id(),
  support_ticket_id       uuid        NOT NULL,
  author_user_id          uuid        NOT NULL,
  is_internal_note        boolean     NOT NULL DEFAULT false,
  body                   text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_messages_pk PRIMARY KEY (id),
  CONSTRAINT ticket_messages_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT ticket_messages_tenant_id_support_ticket_id_fk FOREIGN KEY (tenant_id, support_ticket_id)
    REFERENCES public.support_tickets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ticket_messages_author_user_id_fk FOREIGN KEY (author_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  -- Composite-FK target (§0.4).
  CONSTRAINT ticket_messages_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Thread in order.
CREATE INDEX ticket_messages_tenant_ticket_idx ON public.ticket_messages (tenant_id, support_ticket_id, id);
--> statement-breakpoint
CREATE TRIGGER ticket_messages_set_updated_at BEFORE UPDATE ON public.ticket_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- outbox_events (§11.8): GLOBAL, no tenant_id
-- ============================================================================

CREATE TABLE public.outbox_events (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  aggregate_table   text        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  event_type        text        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}',
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  available_at      timestamptz NOT NULL DEFAULT now(),
  attempts          smallint    NOT NULL DEFAULT 0,
  processed_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_pk PRIMARY KEY (id),
  CONSTRAINT outbox_events_event_type_ck CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT outbox_events_payload_ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_attempts_ck CHECK (attempts >= 0)
);
--> statement-breakpoint
-- Relay poll.
CREATE INDEX outbox_events_poll_idx ON public.outbox_events (available_at, id)
  WHERE processed_at IS NULL;
--> statement-breakpoint
-- Debugging an entity's event history.
CREATE INDEX outbox_events_aggregate_idx ON public.outbox_events (aggregate_table, aggregate_id, id);
--> statement-breakpoint
-- Purge.
CREATE INDEX outbox_events_occurred_at_brin_idx ON public.outbox_events USING brin (occurred_at);
--> statement-breakpoint
CREATE TRIGGER outbox_events_set_updated_at BEFORE UPDATE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- legal_holds (§11.9): GLOBAL
-- ============================================================================

CREATE TABLE public.legal_holds (
  id                     uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  subject_type_code       text        NOT NULL,
  subject_id              uuid        NOT NULL,  -- polymorphic by decision, no FK (§13.14 exception)
  subject_tenant_id        uuid,
  reason                 text        NOT NULL,
  external_reference       text,
  placed_by_user_id        uuid        NOT NULL,
  placed_at               timestamptz NOT NULL DEFAULT now(),
  released_by_user_id      uuid,
  released_at              timestamptz,
  release_reason           text,
  scrub_on_release         boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_holds_pk PRIMARY KEY (id),
  CONSTRAINT legal_holds_subject_type_code_fk FOREIGN KEY (subject_type_code)
    REFERENCES public.legal_hold_subject_types (code) ON DELETE RESTRICT,
  CONSTRAINT legal_holds_subject_tenant_id_fk FOREIGN KEY (subject_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT legal_holds_placed_by_user_id_fk FOREIGN KEY (placed_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT legal_holds_released_by_user_id_fk FOREIGN KEY (released_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT legal_holds_reason_ck CHECK (btrim(reason) <> ''),
  CONSTRAINT legal_holds_release_ck CHECK (
    (released_at IS NULL) = (released_by_user_id IS NULL)
    AND (released_at IS NULL) = (release_reason IS NULL)
  )
);
--> statement-breakpoint
-- The check every job runs.
CREATE INDEX legal_holds_open_subject_idx ON public.legal_holds (subject_type_code, subject_id)
  WHERE released_at IS NULL;
--> statement-breakpoint
-- Holds per tenant.
CREATE INDEX legal_holds_tenant_placed_idx ON public.legal_holds (subject_tenant_id, placed_at DESC);
--> statement-breakpoint
-- Open-holds register.
CREATE INDEX legal_holds_open_register_idx ON public.legal_holds (placed_at DESC)
  WHERE released_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER legal_holds_set_updated_at BEFORE UPDATE ON public.legal_holds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Verifies the subject exists at placement (runs as the caller: platform_admin
-- can already see any subject row via each table's platform override policy,
-- and a tenant moderator/tenant_admin placing a hold on their own tenant's
-- post/media can already see it via that table's normal tenant visibility —
-- no SECURITY DEFINER needed here, only legal_hold_blocks() itself is).
CREATE OR REPLACE FUNCTION public.legal_holds_verify_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subject_exists boolean;
BEGIN
  CASE NEW.subject_type_code
    WHEN 'post' THEN
      SELECT EXISTS (SELECT 1 FROM public.posts WHERE id = NEW.subject_id) INTO subject_exists;
    WHEN 'media_asset' THEN
      SELECT EXISTS (SELECT 1 FROM public.media_assets WHERE id = NEW.subject_id) INTO subject_exists;
    WHEN 'user' THEN
      SELECT EXISTS (SELECT 1 FROM public.users WHERE id = NEW.subject_id) INTO subject_exists;
    WHEN 'conversation' THEN
      SELECT EXISTS (SELECT 1 FROM public.conversations WHERE id = NEW.subject_id) INTO subject_exists;
    WHEN 'message' THEN
      SELECT EXISTS (SELECT 1 FROM public.messages WHERE id = NEW.subject_id) INTO subject_exists;
    WHEN 'store' THEN
      SELECT EXISTS (SELECT 1 FROM public.stores WHERE id = NEW.subject_id) INTO subject_exists;
    ELSE
      subject_exists := false;
  END CASE;
  IF NOT subject_exists THEN
    RAISE EXCEPTION 'legal_holds: no % subject % (or not visible to the placing role)',
      NEW.subject_type_code, NEW.subject_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER legal_holds_a_verify_subject BEFORE INSERT ON public.legal_holds
  FOR EACH ROW EXECUTE FUNCTION public.legal_holds_verify_subject();
--> statement-breakpoint

-- legal_hold_blocks(): SECURITY DEFINER (owned by ae_rls_bypass, §13.5) —
-- every purge_*/scrub_*/anonymize_* function must call this, including ones
-- running in user context (account deletion), without needing read access
-- to legal_holds or to the subjects of transitive coverage it must check
-- (e.g. a message's other conversation participants, a media asset's
-- uploader) that the calling context wouldn't otherwise be able to see.
-- Transitive rule (§11.9): media -> any post/message it's attached to, or
-- its uploader; post -> its author; message -> its conversation;
-- conversation -> any participant; store -> its owner.
CREATE OR REPLACE FUNCTION public.legal_hold_blocks(target_subject_type text, target_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.legal_holds lh
    WHERE lh.subject_type_code = target_subject_type
      AND lh.subject_id = target_subject_id
      AND lh.released_at IS NULL
  )
  OR (
    target_subject_type = 'media_asset' AND (
      EXISTS (
        SELECT 1 FROM public.media_attachments ma
        JOIN public.legal_holds lh
          ON lh.subject_type_code = 'post' AND lh.subject_id = ma.post_id AND lh.released_at IS NULL
        WHERE ma.media_asset_id = target_subject_id AND ma.post_id IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.messages m
        JOIN public.legal_holds lh
          ON lh.subject_type_code = 'message' AND lh.subject_id = m.id AND lh.released_at IS NULL
        WHERE m.media_asset_id = target_subject_id
      )
      OR EXISTS (
        SELECT 1 FROM public.media_assets asset
        JOIN public.legal_holds lh
          ON lh.subject_type_code = 'user' AND lh.subject_id = asset.uploaded_by_user_id AND lh.released_at IS NULL
        WHERE asset.id = target_subject_id AND asset.uploaded_by_user_id IS NOT NULL
      )
    )
  )
  OR (
    target_subject_type = 'post' AND EXISTS (
      SELECT 1 FROM public.posts p
      JOIN public.tenant_members tm ON tm.id = p.author_member_id
      JOIN public.legal_holds lh
        ON lh.subject_type_code = 'user' AND lh.subject_id = tm.user_id AND lh.released_at IS NULL
      WHERE p.id = target_subject_id
    )
  )
  OR (
    target_subject_type = 'message' AND EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.legal_holds lh
        ON lh.subject_type_code = 'conversation' AND lh.subject_id = m.conversation_id AND lh.released_at IS NULL
      WHERE m.id = target_subject_id
    )
  )
  OR (
    target_subject_type = 'conversation' AND EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      JOIN public.tenant_members tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.member_id
      JOIN public.legal_holds lh
        ON lh.subject_type_code = 'user' AND lh.subject_id = tm.user_id AND lh.released_at IS NULL
      WHERE cp.conversation_id = target_subject_id
    )
  )
  OR (
    target_subject_type = 'store' AND EXISTS (
      SELECT 1 FROM public.stores s
      JOIN public.tenant_members tm ON tm.id = s.owner_member_id
      JOIN public.legal_holds lh
        ON lh.subject_type_code = 'user' AND lh.subject_id = tm.user_id AND lh.released_at IS NULL
      WHERE s.id = target_subject_id
    )
  )
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.legal_hold_blocks(text, uuid) IS
  'True when an open legal hold covers this subject directly or transitively (§11.9). SECURITY DEFINER: purge/scrub/anonymize jobs must get a straight answer regardless of their own RLS visibility.';
--> statement-breakpoint
ALTER FUNCTION public.legal_hold_blocks(text, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_hold_blocks(text, uuid) TO ae_app;
--> statement-breakpoint
-- BYPASSRLS bypasses row-level policies but NOT base table-level GRANTs
-- (0009/0010 precedent) — ae_rls_bypass needs explicit SELECT on every
-- table this function queries.
GRANT SELECT ON public.legal_holds TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.media_attachments TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.messages TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.media_assets TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.posts TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.tenant_members TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.conversation_participants TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.stores TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- agent_cash_remittances (§11.10): TENANT-SCOPED
-- ============================================================================

CREATE TABLE public.agent_cash_remittances (
  id                       uuid          NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                uuid          NOT NULL DEFAULT public.current_tenant_id(),
  field_agent_id           uuid          NOT NULL,
  amount                   numeric(12,2) NOT NULL,
  method_code              text          NOT NULL,
  external_reference        text,
  status_code              text          NOT NULL DEFAULT 'submitted',
  submitted_at             timestamptz   NOT NULL DEFAULT now(),
  confirmed_by_user_id      uuid,
  confirmed_at             timestamptz,
  dispute_note              text,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT agent_cash_remittances_pk PRIMARY KEY (id),
  CONSTRAINT agent_cash_remittances_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT agent_cash_remittances_tenant_id_field_agent_id_fk FOREIGN KEY (tenant_id, field_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_cash_remittances_confirmed_by_user_id_fk FOREIGN KEY (confirmed_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT agent_cash_remittances_method_code_fk FOREIGN KEY (method_code)
    REFERENCES public.remittance_methods (code) ON DELETE RESTRICT,
  CONSTRAINT agent_cash_remittances_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.remittance_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT agent_cash_remittances_amount_ck CHECK (amount > 0),
  CONSTRAINT agent_cash_remittances_external_reference_ck CHECK (
    method_code = 'cash_handover' OR external_reference IS NOT NULL
  ),
  CONSTRAINT agent_cash_remittances_confirmed_ck CHECK (
    (confirmed_at IS NULL) = (confirmed_by_user_id IS NULL)
  ),
  -- Composite-FK target (§0.4). Payments covered point here via
  -- payments.agent_remittance_id.
  CONSTRAINT agent_cash_remittances_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_cash_remittances_method_reference_uq ON public.agent_cash_remittances (method_code, external_reference)
  WHERE external_reference IS NOT NULL;
--> statement-breakpoint
-- Agent history; also the tenant_id index.
CREATE INDEX agent_cash_remittances_tenant_agent_submitted_idx ON public.agent_cash_remittances (tenant_id, field_agent_id, submitted_at DESC);
--> statement-breakpoint
-- Partner worklist.
CREATE INDEX agent_cash_remittances_tenant_worklist_idx ON public.agent_cash_remittances (tenant_id, status_code)
  WHERE status_code IN ('submitted', 'disputed');
--> statement-breakpoint
CREATE TRIGGER agent_cash_remittances_set_updated_at BEFORE UPDATE ON public.agent_cash_remittances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Two controls that need a join, so a CHECK alone can't express them
-- (§11.10): an agent can't confirm their own remittance, and a remittance
-- being confirmed must equal the sum of the payments it covers.
CREATE OR REPLACE FUNCTION public.agent_cash_remittances_validate_confirmation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  agent_user_id uuid;
  covered_total numeric(12,2);
BEGIN
  IF NEW.confirmed_by_user_id IS NOT NULL THEN
    SELECT tm.user_id INTO agent_user_id
    FROM public.field_agents fa
    JOIN public.tenant_members tm ON tm.tenant_id = fa.tenant_id AND tm.id = fa.member_id
    WHERE fa.tenant_id = NEW.tenant_id AND fa.id = NEW.field_agent_id;
    IF NEW.confirmed_by_user_id = agent_user_id THEN
      RAISE EXCEPTION 'agent_cash_remittances: an agent may not confirm their own remittance (id %)', NEW.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.status_code = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status_code <> 'confirmed') THEN
    SELECT coalesce(sum(amount), 0) INTO covered_total
    FROM public.payments WHERE agent_remittance_id = NEW.id;
    IF NEW.amount <> covered_total THEN
      RAISE EXCEPTION 'agent_cash_remittances: amount % does not match the sum of covered payments % (id %)',
        NEW.amount, covered_total, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agent_cash_remittances_a_validate_confirmation BEFORE INSERT OR UPDATE ON public.agent_cash_remittances
  FOR EACH ROW EXECUTE FUNCTION public.agent_cash_remittances_validate_confirmation();


-- ============================================================================
-- New setting: agent_visit_edit_window_hours (CLAUDE.md rule 9).
-- platform_settings has FORCE ROW LEVEL SECURITY and a platform_admin-only
-- write policy (0003) — ae_migrator owns the table but FORCE means even the
-- owner is subject to that policy, so this transaction-scoped flag is
-- needed for the INSERT (same trick as 0010's moderation_reasons extension).
-- ============================================================================

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint
INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('agent_visit_edit_window_hours', '24', 'integer', 'hours', 0, NULL, 'none',
   'Hours after creation an agent_visits row may still be edited before it locks for proof integrity.');


-- ============================================================================
-- Closing deferred FKs that already point here.
-- ============================================================================

ALTER TABLE public.place_claims
  ADD CONSTRAINT place_claims_tenant_id_agent_visit_id_fk FOREIGN KEY (tenant_id, agent_visit_id)
    REFERENCES public.agent_visits (tenant_id, id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_review_id_fk FOREIGN KEY (tenant_id, review_id)
    REFERENCES public.reviews (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_notice_id_fk FOREIGN KEY (tenant_id, notice_id)
    REFERENCES public.notices (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_lost_found_item_id_fk FOREIGN KEY (tenant_id, lost_found_item_id)
    REFERENCES public.lost_found_items (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_agent_visit_id_fk FOREIGN KEY (tenant_id, agent_visit_id)
    REFERENCES public.agent_visits (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_ticket_message_id_fk FOREIGN KEY (tenant_id, ticket_message_id)
    REFERENCES public.ticket_messages (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint

-- business_verifications was missing the composite-FK-target unique
-- constraint every other tenant-scoped table gets (§0.4) — added here,
-- needed to close media_attachments.business_verification_id.
ALTER TABLE public.business_verifications
  ADD CONSTRAINT business_verifications_tenant_id_id_uq UNIQUE (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.media_attachments
  ADD CONSTRAINT media_attachments_tenant_id_business_verification_id_fk FOREIGN KEY (tenant_id, business_verification_id)
    REFERENCES public.business_verifications (tenant_id, id) ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE public.business_verifications
  ADD CONSTRAINT business_verifications_tenant_id_agent_visit_id_fk FOREIGN KEY (tenant_id, agent_visit_id)
    REFERENCES public.agent_visits (tenant_id, id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_legal_hold_id_fk FOREIGN KEY (legal_hold_id)
    REFERENCES public.legal_holds (id) ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE public.payments
  ADD CONSTRAINT payments_tenant_id_collected_by_agent_id_fk FOREIGN KEY (tenant_id, collected_by_agent_id)
    REFERENCES public.field_agents (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.payments
  ADD CONSTRAINT payments_tenant_id_agent_remittance_id_fk FOREIGN KEY (tenant_id, agent_remittance_id)
    REFERENCES public.agent_cash_remittances (tenant_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
-- A composite FK with a nullable tenant_id is unchecked (MATCH SIMPLE) if
-- tenant_id alone is NULL; this closes that gap explicitly (cash-agent
-- payments are always tenant-scoped in practice, now enforced).
ALTER TABLE public.payments
  ADD CONSTRAINT payments_agent_remittance_tenant_ck CHECK (agent_remittance_id IS NULL OR tenant_id IS NOT NULL);
--> statement-breakpoint
-- FK indexes (§0.4) for the two payments columns just closed.
CREATE INDEX payments_collected_by_agent_id_idx ON public.payments (tenant_id, collected_by_agent_id)
  WHERE collected_by_agent_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX payments_agent_remittance_id_idx ON public.payments (agent_remittance_id)
  WHERE agent_remittance_id IS NOT NULL;


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
      AND c.relkind IN ('r', 'p')
      AND c.relname IN (
        'remittance_methods', 'remittance_statuses', 'legal_hold_subject_types', 'agent_employment_types',
        'agent_statuses', 'visit_purposes', 'visit_outcomes', 'commission_sources', 'commission_statuses',
        'activity_event_types', 'ticket_categories', 'ticket_statuses', 'ticket_priorities',
        'field_agents', 'agent_visits', 'agent_commissions', 'activity_logs', 'support_tickets',
        'ticket_messages', 'outbox_events', 'legal_holds', 'agent_cash_remittances'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002-0011) ----

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'remittance_methods', 'remittance_statuses', 'legal_hold_subject_types', 'agent_employment_types',
    'agent_statuses', 'visit_purposes', 'visit_outcomes', 'commission_sources', 'commission_statuses',
    'activity_event_types', 'ticket_categories', 'ticket_statuses', 'ticket_priorities'
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

-- ---- field_agents (§11.1): T-ISOLATE ---------------------------------

CREATE POLICY field_agents_self_select ON public.field_agents
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY field_agents_staff_read ON public.field_agents
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY field_agents_tenant_admin_write ON public.field_agents
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY field_agents_platform_admin ON public.field_agents
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- agent_visits (§11.2): T-ISOLATE ----------------------------------

CREATE POLICY agent_visits_agent_own ON public.agent_visits
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_visits_staff_read ON public.agent_visits
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY agent_visits_platform_admin ON public.agent_visits
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- agent_commissions (§11.3): T-ISOLATE. Accrual is system-only ----

CREATE POLICY agent_commissions_agent_select ON public.agent_commissions
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_commissions_system_insert ON public.agent_commissions
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY agent_commissions_staff_manage ON public.agent_commissions
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY agent_commissions_platform_admin ON public.agent_commissions
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- activity_logs (§11.5): T-ISOLATE. No UPDATE for anyone ----------

CREATE POLICY activity_logs_member_select ON public.activity_logs
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY activity_logs_tenant_admin_select ON public.activity_logs
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY activity_logs_insert ON public.activity_logs
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY activity_logs_platform_select ON public.activity_logs
  FOR SELECT USING ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- support_tickets (§11.6): T-ISOLATE -------------------------------

CREATE POLICY support_tickets_requester_select ON public.support_tickets
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND requester_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY support_tickets_requester_insert ON public.support_tickets
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND requester_member_id = (SELECT public.current_member_id()));
--> statement-breakpoint
CREATE POLICY support_tickets_staff_all ON public.support_tickets
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY support_tickets_platform_all ON public.support_tickets
  FOR ALL USING ((SELECT public.app_is_platform())) WITH CHECK ((SELECT public.app_is_platform()));
--> statement-breakpoint

-- ---- ticket_messages (§11.7): T-ISOLATE -------------------------------

CREATE POLICY ticket_messages_requester_select ON public.ticket_messages
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND NOT is_internal_note
    AND EXISTS (
      SELECT 1 FROM public.support_tickets st
      WHERE st.tenant_id = ticket_messages.tenant_id
        AND st.id = ticket_messages.support_ticket_id
        AND st.requester_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY ticket_messages_requester_insert ON public.ticket_messages
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND NOT is_internal_note
    AND author_user_id = (SELECT public.current_user_id())
    AND EXISTS (
      SELECT 1 FROM public.support_tickets st
      WHERE st.tenant_id = ticket_messages.tenant_id
        AND st.id = ticket_messages.support_ticket_id
        AND st.requester_member_id = (SELECT public.current_member_id())
    )
  );
--> statement-breakpoint
CREATE POLICY ticket_messages_staff_all ON public.ticket_messages
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_staff()));
--> statement-breakpoint
CREATE POLICY ticket_messages_platform_all ON public.ticket_messages
  FOR ALL USING ((SELECT public.app_is_platform())) WITH CHECK ((SELECT public.app_is_platform()));
--> statement-breakpoint

-- ---- outbox_events (§11.8): SYSTEM-ONLY except open INSERT -----------

CREATE POLICY outbox_events_insert ON public.outbox_events
  FOR INSERT WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY outbox_events_system_manage ON public.outbox_events
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- legal_holds (§11.9): GLOBAL, platform-controlled -----------------

CREATE POLICY legal_holds_platform_select ON public.legal_holds
  FOR SELECT
  USING ((SELECT public.app_role()) IN ('platform_admin', 'platform_support'));
--> statement-breakpoint
CREATE POLICY legal_holds_platform_admin_insert ON public.legal_holds
  FOR INSERT
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY legal_holds_tenant_staff_insert ON public.legal_holds
  FOR INSERT
  WITH CHECK (
    subject_tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_staff())
    AND subject_type_code IN ('post', 'media_asset')
  );
--> statement-breakpoint
CREATE POLICY legal_holds_platform_admin_release ON public.legal_holds
  FOR UPDATE
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- agent_cash_remittances (§11.10): T-ISOLATE -----------------------

CREATE POLICY agent_cash_remittances_agent_select ON public.agent_cash_remittances
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_cash_remittances_agent_insert ON public.agent_cash_remittances
  FOR INSERT
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.is_my_field_agent(field_agent_id)));
--> statement-breakpoint
CREATE POLICY agent_cash_remittances_staff_manage ON public.agent_cash_remittances
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY agent_cash_remittances_platform_select ON public.agent_cash_remittances
  FOR SELECT USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY agent_cash_remittances_platform_admin ON public.agent_cash_remittances
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));


-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON
  public.remittance_methods, public.remittance_statuses, public.legal_hold_subject_types,
  public.agent_employment_types, public.agent_statuses, public.visit_purposes, public.visit_outcomes,
  public.commission_sources, public.commission_statuses, public.activity_event_types,
  public.ticket_categories, public.ticket_statuses, public.ticket_priorities
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.remittance_methods, public.remittance_statuses, public.legal_hold_subject_types,
  public.agent_employment_types, public.agent_statuses, public.visit_purposes, public.visit_outcomes,
  public.commission_sources, public.commission_statuses, public.activity_event_types,
  public.ticket_categories, public.ticket_statuses, public.ticket_priorities
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.field_agents TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.agent_visits TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.agent_commissions TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.activity_logs TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.support_tickets TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.ticket_messages TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outbox_events TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.legal_holds TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.agent_cash_remittances TO ae_app;

-- 0059_bans_appeals
--
-- Bans, appeals, the global blacklist and complaints (ADR 063, schema.md
-- §9.6, §9.8–§9.10, §13.28 — the Q15b decision). The tables of 0010 had no
-- writer yet; this migration adds what they need and the functions that are
-- now their only write path:
--
--   bans                 + reference_code (shown to the user: "BN-…").
--                        INSERT/UPDATE revoked from ae_app (issue_ban,
--                        lift_ban, decide_appeal, expire_bans only).
--   blacklist_entries    + reference_code, phone_hash (HMAC of the phone,
--                        computed by the API — the raw number is no longer
--                        written), review_note. Identifier CHECK counts
--                        phone_hash. Its RLS (tenant admins insert only
--                        'recommended', platform admin alone updates) stays as
--                        the second line; the API writes through functions.
--   ban_appeals          + tenant_recommendation / tenant_note /
--                        tenant_reviewed_by_user_id / tenant_reviewed_at (a
--                        tenant's "uphold" is a recommendation, never final),
--                        escalation_reason, replacement_ban_id,
--                        replacement_blacklist_entry_id. INSERT/UPDATE revoked
--                        from ae_app.
--   moderation_actions   + ban_id, blacklist_entry_id targets.
--   NEW complaints       TENANT-SCOPED (the subject's area): user-submitted,
--                        distinct from content reports; category, priority,
--                        assignment, status, SLA due time, resolution.
--                        Lookups complaint_categories / _priorities / _statuses.
--
-- Severities (§9.10): restricted (signs in, browses; no posting, chat or
-- reviews), banned (signs in to an appeal-only scope), terminated (no sign-in;
-- the public OTP appeal path only — global blacklist only).
--
-- Error codes: AE801 ban not allowed, AE802 no such active ban, AE803 appeal
-- not allowed, AE804 appeal decision invalid, AE805 blacklist not allowed,
-- AE806 complaint not allowed, AE807 complaint update invalid. The DETAIL
-- names the reason.

-- ============================================================================
-- Lookups
-- ============================================================================

CREATE TABLE public.complaint_categories (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  -- A code, not a number: where a new complaint of this kind starts.
  default_priority_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complaint_categories_pk PRIMARY KEY (code),
  CONSTRAINT complaint_categories_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE public.complaint_priorities (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  -- The platform setting holding this priority's SLA hours.
  sla_setting_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complaint_priorities_pk PRIMARY KEY (code),
  CONSTRAINT complaint_priorities_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE public.complaint_statuses (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complaint_statuses_pk PRIMARY KEY (code),
  CONSTRAINT complaint_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER complaint_categories_set_updated_at BEFORE UPDATE ON public.complaint_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER complaint_priorities_set_updated_at BEFORE UPDATE ON public.complaint_priorities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER complaint_statuses_set_updated_at BEFORE UPDATE ON public.complaint_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.complaint_priorities (code, label_key, sort_order, sla_setting_key) VALUES
  ('low', 'enum.complaint_priorities.low', 10, 'complaint_sla_hours_low'),
  ('normal', 'enum.complaint_priorities.normal', 20, 'complaint_sla_hours_normal'),
  ('high', 'enum.complaint_priorities.high', 30, 'complaint_sla_hours_high'),
  ('urgent', 'enum.complaint_priorities.urgent', 40, 'complaint_sla_hours_urgent');
--> statement-breakpoint
ALTER TABLE public.complaint_categories ADD CONSTRAINT complaint_categories_default_priority_fk
  FOREIGN KEY (default_priority_code) REFERENCES public.complaint_priorities (code) ON DELETE RESTRICT;
--> statement-breakpoint
INSERT INTO public.complaint_categories (code, label_key, sort_order, default_priority_code) VALUES
  ('fake_seller', 'enum.complaint_categories.fake_seller', 10, 'high'),
  ('scam', 'enum.complaint_categories.scam', 20, 'urgent'),
  ('abuse', 'enum.complaint_categories.abuse', 30, 'high'),
  ('other', 'enum.complaint_categories.other', 40, 'normal');
--> statement-breakpoint
INSERT INTO public.complaint_statuses (code, label_key, sort_order) VALUES
  ('pending', 'enum.complaint_statuses.pending', 10),
  ('in_progress', 'enum.complaint_statuses.in_progress', 20),
  ('resolved', 'enum.complaint_statuses.resolved', 30);
--> statement-breakpoint

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('ban_issued', 'enum.moderation_action_types.ban_issued', 400),
  ('ban_lifted', 'enum.moderation_action_types.ban_lifted', 410),
  ('appeal_granted', 'enum.moderation_action_types.appeal_granted', 420),
  ('appeal_reduced', 'enum.moderation_action_types.appeal_reduced', 430),
  ('appeal_upheld', 'enum.moderation_action_types.appeal_upheld', 440),
  ('appeal_escalated', 'enum.moderation_action_types.appeal_escalated', 450),
  ('blacklist_recommended', 'enum.moderation_action_types.blacklist_recommended', 460),
  ('blacklist_approved', 'enum.moderation_action_types.blacklist_approved', 470),
  ('blacklist_rejected', 'enum.moderation_action_types.blacklist_rejected', 480),
  ('blacklist_revoked', 'enum.moderation_action_types.blacklist_revoked', 490);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('account_ban', 'enum.moderation_reasons.account_ban', 400),
  ('ban_appeal', 'enum.moderation_reasons.ban_appeal', 410),
  ('blacklist_review', 'enum.moderation_reasons.blacklist_review', 420);
--> statement-breakpoint

-- Who may do what (RequirePermission). tenant_admin has '*' already.
INSERT INTO public.role_permissions (role_id, module, action)
SELECT r.id, grant_row.module, grant_row.action
FROM public.roles r
JOIN (VALUES
  ('moderator', 'bans', 'read'), ('moderator', 'bans', 'write'),
  ('executive', 'complaints', 'read'), ('executive', 'complaints', 'write')
) AS grant_row (role_code, module, action) ON grant_row.role_code = r.code
WHERE r.tenant_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- Reference codes: short, non-guessable, shown to the user
-- ============================================================================

-- gen_random_uuid() is a cryptographic source (PostgreSQL core). 10 hex
-- characters = 40 bits; the unique constraints catch the rare collision.
CREATE OR REPLACE FUNCTION public.ban_reference(p_prefix text)
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $$
  SELECT p_prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;
--> statement-breakpoint

-- ============================================================================
-- bans, blacklist_entries, ban_appeals, moderation_actions: new columns
-- ============================================================================

ALTER TABLE public.bans
  ADD COLUMN reference_code text NOT NULL DEFAULT public.ban_reference('BN'),
  ADD CONSTRAINT bans_reference_code_uq UNIQUE (reference_code);
--> statement-breakpoint
-- The immutability trigger compares content columns only; reference_code is
-- set once on insert, so it joins them.
CREATE OR REPLACE FUNCTION public.bans_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bans rows cannot be deleted (revoke instead)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status_code IN ('revoked', 'expired', 'superseded') THEN
    RAISE EXCEPTION 'bans: already ended (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF row(NEW.id, NEW.tenant_id, NEW.user_id, NEW.severity_code, NEW.reason_code, NEW.reason_text,
         NEW.evidence_refs, NEW.banned_by_user_id, NEW.is_permanent, NEW.starts_at, NEW.expires_at,
         NEW.escalation_step, NEW.ladder_override_reason, NEW.previous_ban_id, NEW.reference_code)
      IS DISTINCT FROM
      row(OLD.id, OLD.tenant_id, OLD.user_id, OLD.severity_code, OLD.reason_code, OLD.reason_text,
         OLD.evidence_refs, OLD.banned_by_user_id, OLD.is_permanent, OLD.starts_at, OLD.expires_at,
         OLD.escalation_step, OLD.ladder_override_reason, OLD.previous_ban_id, OLD.reference_code) THEN
    RAISE EXCEPTION 'bans: only status/revoke fields may change after insert (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

ALTER TABLE public.blacklist_entries
  ADD COLUMN reference_code text NOT NULL DEFAULT public.ban_reference('BL'),
  ADD COLUMN phone_hash text,
  ADD COLUMN review_note text,
  ADD CONSTRAINT blacklist_entries_reference_code_uq UNIQUE (reference_code),
  ADD CONSTRAINT blacklist_entries_phone_hash_ck CHECK (phone_hash IS NULL OR phone_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE public.blacklist_entries DROP CONSTRAINT blacklist_entries_identifier_ck;
--> statement-breakpoint
ALTER TABLE public.blacklist_entries ADD CONSTRAINT blacklist_entries_identifier_ck
  CHECK (num_nonnulls(user_id, phone_e164, phone_hash, document_number_hash, device_fingerprint_hash) >= 1);
--> statement-breakpoint
CREATE INDEX blacklist_entries_phone_hash_active_idx ON public.blacklist_entries (phone_hash)
  WHERE status_code = 'active';
--> statement-breakpoint
-- One pending recommendation per person.
CREATE UNIQUE INDEX blacklist_entries_user_recommended_uq ON public.blacklist_entries (user_id)
  WHERE status_code = 'recommended' AND user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX blacklist_entries_expiry_idx ON public.blacklist_entries (expires_at)
  WHERE status_code = 'active' AND expires_at IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.ban_appeals
  ADD COLUMN tenant_recommendation text,
  ADD COLUMN tenant_note text,
  ADD COLUMN tenant_reviewed_by_user_id uuid,
  ADD COLUMN tenant_reviewed_at timestamptz,
  ADD COLUMN escalation_reason text,
  ADD COLUMN replacement_ban_id uuid,
  ADD COLUMN replacement_blacklist_entry_id uuid,
  ADD CONSTRAINT ban_appeals_tenant_reviewed_by_user_id_fk FOREIGN KEY (tenant_reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT ban_appeals_replacement_ban_id_fk FOREIGN KEY (replacement_ban_id)
    REFERENCES public.bans (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ban_appeals_replacement_blacklist_entry_id_fk FOREIGN KEY (replacement_blacklist_entry_id)
    REFERENCES public.blacklist_entries (id) ON DELETE RESTRICT,
  -- A tenant can only recommend upholding; the platform makes it final.
  ADD CONSTRAINT ban_appeals_tenant_recommendation_ck CHECK (tenant_recommendation IS NULL OR tenant_recommendation = 'uphold'),
  ADD CONSTRAINT ban_appeals_escalation_reason_ck
    CHECK (escalation_reason IS NULL OR escalation_reason IN ('timeout', 'tenant_upheld')),
  ADD CONSTRAINT ban_appeals_decided_ck
    CHECK (status_code NOT IN ('upheld', 'granted', 'reduced') OR (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX ban_appeals_tenant_reviewed_by_idx ON public.ban_appeals (tenant_reviewed_by_user_id)
  WHERE tenant_reviewed_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ban_appeals_blacklist_entry_idx ON public.ban_appeals (blacklist_entry_id)
  WHERE blacklist_entry_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.moderation_actions
  ADD COLUMN ban_id uuid,
  ADD COLUMN blacklist_entry_id uuid,
  ADD CONSTRAINT moderation_actions_tenant_id_ban_id_fk FOREIGN KEY (tenant_id, ban_id)
    REFERENCES public.bans (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT moderation_actions_blacklist_entry_id_fk FOREIGN KEY (blacklist_entry_id)
    REFERENCES public.blacklist_entries (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_one_target_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions
  ADD CONSTRAINT moderation_actions_one_target_ck
    CHECK (num_nonnulls(post_id, place_id, place_claim_id, store_id, conversation_id, review_id, verification_id,
                        ban_id, blacklist_entry_id) = 1);
--> statement-breakpoint
CREATE INDEX moderation_actions_tenant_ban_idx ON public.moderation_actions (tenant_id, ban_id, id DESC)
  WHERE ban_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX moderation_actions_blacklist_entry_idx ON public.moderation_actions (blacklist_entry_id, id DESC)
  WHERE blacklist_entry_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- complaints: TENANT-SCOPED (the subject's area)
-- ============================================================================

CREATE TABLE public.complaints (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
  reference_code        text        NOT NULL DEFAULT public.ban_reference('CP'),
  reporter_user_id      uuid        NOT NULL,
  -- user: a person (users.id); store: a store of this area.
  subject_type          text        NOT NULL,
  subject_id            uuid        NOT NULL,
  category_code         text        NOT NULL,
  priority_code         text        NOT NULL,
  status_code           text        NOT NULL DEFAULT 'pending',
  description           text        NOT NULL,
  evidence_refs         jsonb       NOT NULL DEFAULT '[]',
  assigned_to_user_id   uuid,
  assigned_at           timestamptz,
  -- created_at + the priority's SLA hours (complaint_sla_hours_*), recomputed when the priority changes.
  due_at                timestamptz NOT NULL,
  sla_breached_at       timestamptz,
  resolution            text,
  resolved_by_user_id   uuid,
  resolved_at           timestamptz,
  -- The ban a resolution issued, if any.
  ban_id                uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complaints_pk PRIMARY KEY (id),
  CONSTRAINT complaints_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT complaints_reference_code_uq UNIQUE (reference_code),
  CONSTRAINT complaints_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT complaints_reporter_user_id_fk FOREIGN KEY (reporter_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT complaints_assigned_to_user_id_fk FOREIGN KEY (assigned_to_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT complaints_resolved_by_user_id_fk FOREIGN KEY (resolved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT complaints_category_code_fk FOREIGN KEY (category_code)
    REFERENCES public.complaint_categories (code) ON DELETE RESTRICT,
  CONSTRAINT complaints_priority_code_fk FOREIGN KEY (priority_code)
    REFERENCES public.complaint_priorities (code) ON DELETE RESTRICT,
  CONSTRAINT complaints_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.complaint_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT complaints_tenant_id_ban_id_fk FOREIGN KEY (tenant_id, ban_id)
    REFERENCES public.bans (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT complaints_subject_type_ck CHECK (subject_type IN ('user', 'store')),
  CONSTRAINT complaints_description_ck CHECK (btrim(description) <> ''),
  CONSTRAINT complaints_evidence_refs_ck CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT complaints_resolved_ck CHECK (
    (status_code = 'resolved') = (resolved_at IS NOT NULL)
    AND (status_code <> 'resolved' OR (resolution IS NOT NULL AND btrim(resolution) <> '' AND resolved_by_user_id IS NOT NULL))
  ),
  CONSTRAINT complaints_assigned_ck CHECK (assigned_to_user_id IS NULL OR assigned_at IS NOT NULL)
);
--> statement-breakpoint
-- The queue: open complaints by due time.
CREATE INDEX complaints_queue_idx ON public.complaints (tenant_id, due_at, id)
  WHERE status_code <> 'resolved';
--> statement-breakpoint
CREATE INDEX complaints_assignee_idx ON public.complaints (tenant_id, assigned_to_user_id, due_at)
  WHERE status_code <> 'resolved' AND assigned_to_user_id IS NOT NULL;
--> statement-breakpoint
-- Cross-tenant system job: SLA breaches.
CREATE INDEX complaints_sla_idx ON public.complaints (due_at)
  WHERE status_code <> 'resolved' AND sla_breached_at IS NULL;
--> statement-breakpoint
-- "My complaints" and the reporter's daily limit.
CREATE INDEX complaints_reporter_idx ON public.complaints (reporter_user_id, id DESC);
--> statement-breakpoint
CREATE INDEX complaints_subject_idx ON public.complaints (tenant_id, subject_type, subject_id, id DESC);
--> statement-breakpoint
-- One open complaint per reporter and subject.
CREATE UNIQUE INDEX complaints_open_uq ON public.complaints (reporter_user_id, subject_type, subject_id)
  WHERE status_code <> 'resolved';
--> statement-breakpoint
CREATE INDEX complaints_assigned_to_user_id_idx ON public.complaints (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX complaints_resolved_by_user_id_idx ON public.complaints (resolved_by_user_id)
  WHERE resolved_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX complaints_ban_id_idx ON public.complaints (tenant_id, ban_id) WHERE ban_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER complaints_set_updated_at BEFORE UPDATE ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.complaints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY['complaint_categories', 'complaint_priorities', 'complaint_statuses']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', enum_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', enum_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (true)', enum_table || '_read_all', enum_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()))',
      enum_table || '_platform_admin', enum_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.complaint_categories, public.complaint_priorities, public.complaint_statuses TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON public.complaint_categories, public.complaint_priorities, public.complaint_statuses TO ae_app;
--> statement-breakpoint

-- complaints: the reporter reads their own (in any area); the area's staff
-- and executives read their area's; platform and system read all. Writes go
-- through the functions below only.
CREATE POLICY complaints_reporter_read ON public.complaints
  FOR SELECT USING (reporter_user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY complaints_staff_read ON public.complaints
  FOR SELECT USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND ((SELECT public.app_is_staff()) OR (SELECT public.app_role()) = 'executive')
  );
--> statement-breakpoint
CREATE POLICY complaints_platform_read ON public.complaints
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
GRANT SELECT ON public.complaints TO ae_app;
--> statement-breakpoint

-- bans and ban_appeals: the functions are the only writers now (ladder,
-- moderation_actions, routing, rate limit). RLS policies stay for reads.
REVOKE INSERT, UPDATE ON public.bans, public.ban_appeals FROM ae_app;
--> statement-breakpoint
-- The tenant admin's FOR ALL policy would let a tenant decide its own ban's
-- appeal by a direct UPDATE; reads only now.
DROP POLICY ban_appeals_tenant_admin_access ON public.ban_appeals;
--> statement-breakpoint
CREATE POLICY ban_appeals_tenant_admin_read ON public.ban_appeals
  FOR SELECT USING (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (SELECT 1 FROM public.bans b WHERE b.id = ban_appeals.ban_id)
  );
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.bans, public.ban_appeals, public.blacklist_entries, public.complaints
  TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.complaint_categories, public.complaint_priorities, public.complaint_statuses,
  public.posts, public.user_devices, public.users, public.user_profiles, public.tenants, public.stores, public.roles
  TO ae_rls_bypass;
--> statement-breakpoint
GRANT UPDATE ON public.auth_refresh_tokens, public.tenant_members TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.auth_refresh_tokens TO ae_rls_bypass;
--> statement-breakpoint
GRANT INSERT ON public.moderation_actions, public.audit_logs TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('ban_state_cache_seconds', '60', 'integer', 'seconds', 5, 3600, 'none',
   'How long the API caches a person''s ban state per area (a ban or lift clears it at once).'),
  ('ban_reason_text_max_length', '2000', 'integer', 'characters', 50, 10000, 'none',
   'Longest internal reason a moderator may write for a ban.'),
  ('ban_job_batch_size', '500', 'integer', 'count', 10, 10000, 'none',
   'Most bans, blacklist entries, appeals and complaints the expiry, escalation and SLA jobs handle per run.'),
  ('appeal_statement_max_length', '2000', 'integer', 'characters', 50, 10000, 'none',
   'Longest statement a person may write in an appeal.'),
  ('appeal_public_token_ttl_seconds', '900', 'integer', 'seconds', 60, 3600, 'none',
   'After the OTP is checked on the public appeal path, how long the appeal-only token from /appeals/status works.'),
  ('appeal_queue_page_size_max', '50', 'integer', 'count', 5, 200, 'none',
   'Largest page of an appeal queue.'),
  ('blacklist_phone_match_days', '365', 'integer', 'days', 0, 3650, 'none',
   'A phone-only blacklist match blocks for this long after the entry was approved; after that it only flags (numbers are recycled, schema.md §13.21).'),
  ('complaint_sla_hours_urgent', '4', 'integer', 'hours', 1, 720, 'platform',
   'An urgent complaint should be resolved within this many hours.'),
  ('complaint_sla_hours_high', '24', 'integer', 'hours', 1, 720, 'platform',
   'A high-priority complaint should be resolved within this many hours.'),
  ('complaint_sla_hours_normal', '72', 'integer', 'hours', 1, 720, 'platform',
   'A normal complaint should be resolved within this many hours.'),
  ('complaint_sla_hours_low', '168', 'integer', 'hours', 1, 2160, 'platform',
   'A low-priority complaint should be resolved within this many hours.'),
  ('complaint_max_per_day', '5', 'integer', 'count', 1, 100, 'platform',
   'Most complaints one person may file per day (across areas).'),
  ('complaint_description_max_length', '2000', 'integer', 'characters', 50, 10000, 'none',
   'Longest complaint description.'),
  ('complaint_queue_page_size_max', '50', 'integer', 'count', 5, 200, 'none',
   'Largest page of the complaint queue.');
--> statement-breakpoint

-- ============================================================================
-- Notifications and scheduled jobs
-- ============================================================================

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('ban_lifted', 'enum.notification_types.ban_lifted', 360),
  ('appeal_received', 'enum.notification_types.appeal_received', 370),
  ('blacklist_recommended', 'enum.notification_types.blacklist_recommended', 380),
  ('complaint_assigned', 'enum.notification_types.complaint_assigned', 390),
  ('complaint_sla_breached', 'enum.notification_types.complaint_sla_breached', 400),
  ('complaint_resolved', 'enum.notification_types.complaint_resolved', 410);
--> statement-breakpoint
-- A lift is an account notice like the ban (SMS too: a terminated person has no app).
UPDATE public.notification_types
SET default_channels = '{in_app,push,sms}', is_urgent = true, sms_eligible = true, user_configurable = false
WHERE code = 'ban_lifted';
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app,push}', user_configurable = false
WHERE code IN ('appeal_received', 'complaint_assigned', 'complaint_sla_breached');
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app}', audience = 'platform', user_configurable = false
WHERE code = 'blacklist_recommended';
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app,push}'
WHERE code = 'complaint_resolved';
--> statement-breakpoint
-- The ban notice now carries its reference (needed to appeal without a
-- session) and how long; the appeal outcome knows "reduced".
DELETE FROM public.notification_templates WHERE type_code IN ('ban_issued', 'appeal_decided');
--> statement-breakpoint
INSERT INTO public.notification_templates
  (type_code, channel_code, locale, variant, title_template, body_template, variables)
VALUES
  ('ban_issued', 'in_app', 'bn', 'single', 'অ্যাকাউন্টে নিষেধাজ্ঞা',
   '{{#areaName}}{{areaName}} এলাকায় {{/areaName}}আপনার অ্যাকাউন্টে নিষেধাজ্ঞা দেওয়া হয়েছে{{#until}}, {{until|date}} পর্যন্ত{{/until}}। রেফারেন্স: {{reference}}। কারণ দেখে আপিল করতে পারেন।',
   '{areaName,until,reference}'),
  ('ban_issued', 'in_app', 'en', 'single', 'A ban on your account',
   'Your account was banned{{#areaName}} in {{areaName}}{{/areaName}}{{#until}} until {{until|date}}{{/until}}. Reference: {{reference}}. See why and appeal.',
   '{areaName,until,reference}'),
  ('ban_issued', 'sms', 'bn', 'single', NULL,
   'আমার এলাকা: আপনার অ্যাকাউন্টে নিষেধাজ্ঞা দেওয়া হয়েছে{{#until}}, {{until|date}} পর্যন্ত{{/until}}। রেফারেন্স {{reference}}। আপিল করতে পারেন।',
   '{until,reference}'),
  ('ban_issued', 'sms', 'en', 'single', NULL,
   'Amar Elaka: a ban was placed on your account{{#until}} until {{until|date}}{{/until}}. Reference {{reference}}. You can appeal.',
   '{until,reference}'),
  ('ban_lifted', 'in_app', 'bn', 'single', 'নিষেধাজ্ঞা তুলে নেওয়া হয়েছে',
   'রেফারেন্স {{reference}}-এর নিষেধাজ্ঞা আর নেই।', '{reference}'),
  ('ban_lifted', 'in_app', 'en', 'single', 'Your ban was lifted',
   'The ban {{reference}} no longer applies.', '{reference}'),
  ('ban_lifted', 'sms', 'bn', 'single', NULL,
   'আমার এলাকা: রেফারেন্স {{reference}}-এর নিষেধাজ্ঞা তুলে নেওয়া হয়েছে।', '{reference}'),
  ('ban_lifted', 'sms', 'en', 'single', NULL,
   'Amar Elaka: the ban {{reference}} was lifted.', '{reference}'),
  ('appeal_decided', 'in_app', 'bn', 'single', 'আপিলের সিদ্ধান্ত',
   '{{#upheld}}আপনার আপিল বিবেচনা করা হয়েছে, তবে নিষেধাজ্ঞা বহাল আছে।{{/upheld}}{{#reduced}}আপনার আপিল বিবেচনা করে নিষেধাজ্ঞার মেয়াদ কমানো হয়েছে।{{/reduced}}{{#granted}}আপনার আপিল গ্রহণ করা হয়েছে, নিষেধাজ্ঞা তুলে নেওয়া হয়েছে।{{/granted}} রেফারেন্স: {{reference}}',
   '{upheld,reduced,granted,reference}'),
  ('appeal_decided', 'in_app', 'en', 'single', 'Your appeal was decided',
   '{{#upheld}}Your appeal was reviewed and the ban stays.{{/upheld}}{{#reduced}}Your appeal was reviewed and the ban was shortened.{{/reduced}}{{#granted}}Your appeal was accepted and the ban is lifted.{{/granted}} Reference: {{reference}}',
   '{upheld,reduced,granted,reference}'),
  ('appeal_decided', 'sms', 'bn', 'single', NULL,
   'আমার এলাকা: আপিল {{reference}} — {{#upheld}}নিষেধাজ্ঞা বহাল আছে।{{/upheld}}{{#reduced}}নিষেধাজ্ঞার মেয়াদ কমানো হয়েছে।{{/reduced}}{{#granted}}নিষেধাজ্ঞা তুলে নেওয়া হয়েছে।{{/granted}}',
   '{upheld,reduced,granted,reference}'),
  ('appeal_decided', 'sms', 'en', 'single', NULL,
   'Amar Elaka: appeal {{reference}} — {{#upheld}}the ban stays.{{/upheld}}{{#reduced}}the ban was shortened.{{/reduced}}{{#granted}}the ban was lifted.{{/granted}}',
   '{upheld,reduced,granted,reference}'),
  ('appeal_received', 'in_app', 'bn', 'single', 'নতুন আপিল',
   'একটি নিষেধাজ্ঞার বিরুদ্ধে আপিল এসেছে ({{reference}})।{{#escalated}} এলাকা সময়মতো সিদ্ধান্ত দেয়নি বা বহাল রাখার সুপারিশ করেছে।{{/escalated}}',
   '{reference,escalated}'),
  ('appeal_received', 'in_app', 'en', 'single', 'New appeal',
   'A ban was appealed ({{reference}}).{{#escalated}} The area did not decide in time or recommended upholding it.{{/escalated}}',
   '{reference,escalated}'),
  ('blacklist_recommended', 'in_app', 'bn', 'single', 'ব্ল্যাকলিস্টের সুপারিশ',
   '{{areaName}} এলাকা একজনকে গ্লোবাল ব্ল্যাকলিস্টে রাখার সুপারিশ করেছে ({{reference}})।', '{areaName,reference}'),
  ('blacklist_recommended', 'in_app', 'en', 'single', 'Blacklist recommendation',
   '{{areaName}} recommended someone for the global blacklist ({{reference}}).', '{areaName,reference}'),
  ('complaint_assigned', 'in_app', 'bn', 'single', 'অভিযোগ আপনাকে দেওয়া হয়েছে',
   'অভিযোগ {{reference}} দেখার দায়িত্ব আপনার, {{dueAt|date}}-এর মধ্যে।', '{reference,dueAt}'),
  ('complaint_assigned', 'in_app', 'en', 'single', 'A complaint was assigned to you',
   'Complaint {{reference}} is yours, due {{dueAt|date}}.', '{reference,dueAt}'),
  ('complaint_sla_breached', 'in_app', 'bn', 'single', 'অভিযোগের সময় পেরিয়ে গেছে',
   'অভিযোগ {{reference}} নির্ধারিত সময়ের মধ্যে নিষ্পত্তি হয়নি।', '{reference}'),
  ('complaint_sla_breached', 'in_app', 'en', 'single', 'Complaint overdue',
   'Complaint {{reference}} was not resolved in time.', '{reference}'),
  ('complaint_resolved', 'in_app', 'bn', 'single', 'আপনার অভিযোগের নিষ্পত্তি হয়েছে',
   'অভিযোগ {{reference}} দেখা হয়েছে। জানানোর জন্য ধন্যবাদ।', '{reference}'),
  ('complaint_resolved', 'in_app', 'en', 'single', 'Your complaint was resolved',
   'Complaint {{reference}} was reviewed. Thank you for telling us.', '{reference}');
--> statement-breakpoint

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('expire-bans', 'enum.scheduled_jobs.expire-bans', 190),
  ('escalate-appeals', 'enum.scheduled_jobs.escalate-appeals', 200),
  ('complaint-sla', 'enum.scheduled_jobs.complaint-sla', 210);
--> statement-breakpoint

-- ============================================================================
-- Helpers
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ban_setting_int(p_key text, p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (public.setting_value_for(p_key, p_tenant_id) #>> '{}')::numeric::integer
$$;
--> statement-breakpoint

-- Severity order, one place: watch < restricted < banned < terminated.
CREATE OR REPLACE FUNCTION public.ban_severity_rank(p_code text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_code WHEN 'terminated' THEN 4 WHEN 'banned' THEN 3 WHEN 'restricted' THEN 2
                     WHEN 'watch' THEN 1 ELSE 0 END
$$;
--> statement-breakpoint

-- Evidence refs (§9.8): [{"type": report|message|post|review|payment|media_asset|support_ticket|complaint|conversation, "id": uuid}].
CREATE OR REPLACE FUNCTION public.ban_evidence_valid(p_refs jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(p_refs) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_refs) e
      WHERE jsonb_typeof(e) <> 'object'
        OR NOT (e ->> 'type') = ANY (ARRAY['report', 'message', 'post', 'review', 'payment', 'media_asset',
                                           'support_ticket', 'complaint', 'conversation'])
        OR NOT pg_input_is_valid(coalesce(e ->> 'id', ''), 'uuid')
    )
$$;
--> statement-breakpoint

-- ============================================================================
-- The ban state: one rule (CLAUDE.md "one implementation per rule")
-- ============================================================================

-- The caller's effective severity in the current area: an active global
-- blacklist entry on their account (never 'watch'), else an active ban in
-- this area. Expiry bites at once (compared with now()), before any job runs.
CREATE OR REPLACE FUNCTION public.my_ban_state()
RETURNS TABLE (severity_code text, source text, ban_id uuid, blacklist_entry_id uuid, reference_code text,
               expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.severity_code, s.source, s.ban_id, s.blacklist_entry_id, s.reference_code, s.expires_at
  FROM (
    SELECT be.severity_code, 'platform'::text AS source, NULL::uuid AS ban_id, be.id AS blacklist_entry_id,
           be.reference_code, be.expires_at, 1 AS tie
    FROM public.blacklist_entries be
    WHERE be.user_id = public.current_user_id() AND be.status_code = 'active'
      AND be.severity_code <> 'watch' AND (be.expires_at IS NULL OR be.expires_at > now())
    UNION ALL
    SELECT b.severity_code, 'area', b.id, NULL, b.reference_code, b.expires_at, 2
    FROM public.bans b
    WHERE b.user_id = public.current_user_id() AND b.tenant_id = public.current_tenant_id()
      AND b.status_code = 'active' AND (b.is_permanent OR b.expires_at > now())
  ) s
  WHERE public.current_user_id() IS NOT NULL
  ORDER BY public.ban_severity_rank(s.severity_code) DESC, s.tie
  LIMIT 1
$$;
--> statement-breakpoint

-- What the person sees on the ban notice (§9.10): severity, why (the reason
-- code — never the internal text or evidence), how long, which area (its
-- name, never a person), the reference, and whether they can appeal now.
-- Every area's active bans plus global entries. One appeal per ban: once
-- decided (upheld), it is final; a reduced ban is a new ban, appealable anew.
CREATE OR REPLACE FUNCTION public.ban_notices_for(p_user_id uuid)
RETURNS TABLE (
  kind text, id uuid, reference_code text, severity_code text, reason_code text,
  area_name_bn text, area_name_en text, starts_at timestamptz, expires_at timestamptz, is_permanent boolean,
  appeal_id uuid, appeal_reference text, appeal_status text, can_appeal boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH n AS (
    SELECT 'area'::text AS kind, b.id, b.reference_code, b.severity_code, b.reason_code,
           t.name_bn, t.name_en, b.starts_at, b.expires_at, b.is_permanent, b.id AS ban_id, NULL::uuid AS entry_id
    FROM public.bans b JOIN public.tenants t ON t.id = b.tenant_id
    WHERE b.user_id = p_user_id AND b.status_code = 'active' AND (b.is_permanent OR b.expires_at > now())
    UNION ALL
    SELECT 'platform', be.id, be.reference_code, be.severity_code, be.reason_code,
           NULL, NULL, coalesce(be.reviewed_at, be.created_at), be.expires_at, be.expires_at IS NULL, NULL, be.id
    FROM public.blacklist_entries be
    WHERE be.user_id = p_user_id AND be.status_code = 'active' AND be.severity_code <> 'watch'
      AND (be.expires_at IS NULL OR be.expires_at > now())
  )
  SELECT n.kind, n.id, n.reference_code, n.severity_code, n.reason_code, n.name_bn, n.name_en,
         n.starts_at, n.expires_at, n.is_permanent, a.id, a.public_reference, a.status_code,
         a.id IS NULL
  FROM n
  LEFT JOIN LATERAL (
    SELECT ba.id, ba.public_reference, ba.status_code
    FROM public.ban_appeals ba
    WHERE (ba.ban_id = n.ban_id OR ba.blacklist_entry_id = n.entry_id)
    ORDER BY ba.id DESC LIMIT 1
  ) a ON true
  ORDER BY public.ban_severity_rank(n.severity_code) DESC, n.starts_at DESC
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.my_ban_notices()
RETURNS TABLE (
  kind text, id uuid, reference_code text, severity_code text, reason_code text,
  area_name_bn text, area_name_en text, starts_at timestamptz, expires_at timestamptz, is_permanent boolean,
  appeal_id uuid, appeal_reference text, appeal_status text, can_appeal boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.ban_notices_for(public.current_user_id()) WHERE public.current_user_id() IS NOT NULL
$$;
--> statement-breakpoint

-- Signup and login (§9.6, ADR 063). Two answers:
--  own:        the account's own entry (user_id) — terminated refuses sign-in,
--              banned/restricted sign in to their limited scope;
--  identifier: another account's entry matched by device fingerprint (the
--              entry's own, or any device that account used) or by phone
--              hash. A phone-only match blocks only while the entry is
--              younger than blacklist_phone_match_days, then it only flags
--              ('watch') — numbers are recycled (§13.21).
CREATE OR REPLACE FUNCTION public.blacklist_match(p_user_id uuid, p_phone_hash text, p_device_hash text)
RETURNS TABLE (own_severity text, identifier_severity text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH active AS (
    SELECT be.* FROM public.blacklist_entries be
    WHERE be.status_code = 'active' AND (be.expires_at IS NULL OR be.expires_at > now())
  ),
  own AS (
    SELECT a.severity_code FROM active a WHERE p_user_id IS NOT NULL AND a.user_id = p_user_id
  ),
  ident AS (
    SELECT a.severity_code FROM active a
    WHERE (a.user_id IS DISTINCT FROM p_user_id OR p_user_id IS NULL)
      AND p_device_hash IS NOT NULL
      AND (a.device_fingerprint_hash = p_device_hash
           OR EXISTS (SELECT 1 FROM public.user_devices ud
                      WHERE ud.user_id = a.user_id AND ud.fingerprint_hash = p_device_hash))
    UNION ALL
    SELECT CASE WHEN coalesce(a.reviewed_at, a.created_at)
                     > now() - make_interval(days => public.ban_setting_int('blacklist_phone_match_days', NULL))
                THEN a.severity_code ELSE 'watch' END
    FROM active a
    WHERE (a.user_id IS DISTINCT FROM p_user_id OR p_user_id IS NULL)
      AND p_phone_hash IS NOT NULL AND a.phone_hash = p_phone_hash
  )
  SELECT (SELECT o.severity_code FROM own o ORDER BY public.ban_severity_rank(o.severity_code) DESC LIMIT 1),
         (SELECT i.severity_code FROM ident i ORDER BY public.ban_severity_rank(i.severity_code) DESC LIMIT 1)
$$;
--> statement-breakpoint

-- ============================================================================
-- Bans: issue, lift, expire
-- ============================================================================

-- A ban in the current area. The ladder (ban_ladder_days, e.g. [7, 30, null])
-- picks the duration from the person's earlier bans here within
-- ban_escalation_lookback_days; anything else needs an override reason.
-- Permanent: tenant admin only, with a reason text and at least one piece
-- of evidence (also the table's CHECK). Writes moderation_actions in the
-- same transaction (rule 13); the membership cache follows by trigger.
CREATE OR REPLACE FUNCTION public.issue_ban(
  p_user_id uuid,
  p_severity text,
  p_reason_code text,
  p_reason_text text,
  p_evidence jsonb,
  p_duration_days integer,
  p_permanent boolean,
  p_override_reason text
)
RETURNS TABLE (id uuid, reference_code text, starts_at timestamptz, expires_at timestamptz, is_permanent boolean,
               escalation_step smallint, area_name_bn text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_actor uuid := public.current_user_id();
  v_role text;
  v_prior integer;
  v_ladder jsonb := public.setting_value_for('ban_ladder_days', v_tenant);
  v_step integer;
  v_ladder_days integer;
  v_permanent boolean;
  v_days integer;
  v_previous uuid;
  v_ban public.bans%ROWTYPE;
BEGIN
  IF NOT (public.app_is_staff() OR public.is_platform_admin()) OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'issue_ban: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'issue_ban: self' USING ERRCODE = 'AE801', DETAIL = 'self';
  END IF;
  IF p_severity NOT IN ('restricted', 'banned') THEN
    RAISE EXCEPTION 'issue_ban: severity' USING ERRCODE = 'AE801', DETAIL = 'severity';
  END IF;
  SELECT tm.role_code INTO v_role FROM public.tenant_members tm
  WHERE tm.tenant_id = v_tenant AND tm.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue_ban: not a member here' USING ERRCODE = 'AE801', DETAIL = 'not_member';
  END IF;
  -- The area's own staff are removed from staff first (or banned by the platform).
  IF v_role IN ('moderator', 'tenant_admin', 'partner_owner', 'executive', 'marketer')
     AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'issue_ban: staff target' USING ERRCODE = 'AE801', DETAIL = 'target_staff';
  END IF;
  IF p_reason_text IS NULL OR btrim(p_reason_text) = '' THEN
    RAISE EXCEPTION 'issue_ban: reason text' USING ERRCODE = 'AE801', DETAIL = 'reason_required';
  END IF;
  IF NOT public.ban_evidence_valid(coalesce(p_evidence, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'issue_ban: evidence shape' USING ERRCODE = 'AE801', DETAIL = 'invalid_evidence';
  END IF;

  -- Serialise bans of one person in one area.
  PERFORM pg_advisory_xact_lock(hashtext('ban:' || v_tenant || ':' || p_user_id));
  SELECT count(*) INTO v_prior FROM public.bans b
  WHERE b.tenant_id = v_tenant AND b.user_id = p_user_id AND b.status_code <> 'revoked'
    AND b.created_at > now() - make_interval(days => public.ban_setting_int('ban_escalation_lookback_days', v_tenant));
  v_step := least(v_prior + 1, jsonb_array_length(v_ladder));
  v_ladder_days := (v_ladder -> (v_step - 1)) #>> '{}';

  IF coalesce(p_permanent, false) THEN
    v_permanent := true;
  ELSIF p_duration_days IS NOT NULL THEN
    IF p_duration_days < 1 THEN
      RAISE EXCEPTION 'issue_ban: duration' USING ERRCODE = 'AE801', DETAIL = 'duration';
    END IF;
    v_permanent := false;
    v_days := p_duration_days;
  ELSE
    v_permanent := v_ladder_days IS NULL;
    v_days := v_ladder_days;
  END IF;
  -- Off the ladder needs a written reason.
  IF (v_permanent <> (v_ladder_days IS NULL) OR (NOT v_permanent AND v_days IS DISTINCT FROM v_ladder_days))
     AND (p_override_reason IS NULL OR btrim(p_override_reason) = '') THEN
    RAISE EXCEPTION 'issue_ban: off the ladder' USING ERRCODE = 'AE801', DETAIL = 'override_reason_required';
  END IF;
  IF v_permanent AND NOT (public.app_is_tenant_admin() OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'issue_ban: permanent needs an admin' USING ERRCODE = 'AE801', DETAIL = 'permanent_needs_admin';
  END IF;
  IF v_permanent AND jsonb_array_length(coalesce(p_evidence, '[]'::jsonb)) < 1 THEN
    RAISE EXCEPTION 'issue_ban: permanent needs evidence' USING ERRCODE = 'AE801', DETAIL = 'evidence_required';
  END IF;

  -- The new ban replaces any active one here.
  SELECT b.id INTO v_previous FROM public.bans b
  WHERE b.tenant_id = v_tenant AND b.user_id = p_user_id ORDER BY b.id DESC LIMIT 1;
  UPDATE public.bans b SET status_code = 'superseded'
  WHERE b.tenant_id = v_tenant AND b.user_id = p_user_id AND b.status_code = 'active';

  INSERT INTO public.bans (tenant_id, user_id, severity_code, reason_code, reason_text, evidence_refs,
                           banned_by_user_id, is_permanent, expires_at, escalation_step,
                           ladder_override_reason, previous_ban_id)
  VALUES (v_tenant, p_user_id, p_severity, p_reason_code, btrim(p_reason_text), coalesce(p_evidence, '[]'::jsonb),
          v_actor, v_permanent, CASE WHEN v_permanent THEN NULL ELSE now() + make_interval(days => v_days) END,
          v_step, nullif(btrim(coalesce(p_override_reason, '')), ''), v_previous)
  RETURNING * INTO v_ban;

  INSERT INTO public.moderation_actions (tenant_id, ban_id, actor_user_id, action_code, reason_code, reason_text,
                                         evidence_refs)
  VALUES (v_tenant, v_ban.id, v_actor, 'ban_issued', 'account_ban',
          p_severity || ' / ' || p_reason_code || ': ' || btrim(p_reason_text), v_ban.evidence_refs);
  -- Trust follows (trust_penalty_per_ban).
  UPDATE public.member_trust_scores ts SET next_recompute_at = now()
  FROM public.tenant_members tm
  WHERE tm.tenant_id = v_tenant AND tm.user_id = p_user_id AND ts.tenant_id = tm.tenant_id AND ts.member_id = tm.id;

  RETURN QUERY
    SELECT v_ban.id, v_ban.reference_code, v_ban.starts_at, v_ban.expires_at, v_ban.is_permanent,
           v_ban.escalation_step, t.name_bn
    FROM public.tenants t WHERE t.id = v_tenant;
END
$$;
--> statement-breakpoint

-- Shared by lift_ban and decide_appeal: end a ban, with its audit row.
CREATE OR REPLACE FUNCTION public.ban_end(p_ban_id uuid, p_actor uuid, p_reason text, p_action text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  UPDATE public.bans b SET status_code = 'revoked', revoked_at = now(), revoked_by_user_id = p_actor,
                           revoke_reason = p_reason
  WHERE b.id = p_ban_id AND b.status_code = 'active'
  RETURNING b.tenant_id INTO v_tenant;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ban_end: not active' USING ERRCODE = 'AE802';
  END IF;
  INSERT INTO public.moderation_actions (tenant_id, ban_id, actor_user_id, action_code, reason_code, reason_text)
  VALUES (v_tenant, p_ban_id, p_actor, p_action, CASE WHEN p_action = 'ban_lifted' THEN 'account_ban' ELSE 'ban_appeal' END,
          p_reason);
END
$$;
--> statement-breakpoint

-- Lift a ban of the current area: its tenant admin (or the platform).
CREATE OR REPLACE FUNCTION public.lift_ban(p_ban_id uuid, p_reason text)
RETURNS TABLE (user_id uuid, tenant_id uuid, reference_code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_ban public.bans%ROWTYPE;
BEGIN
  IF NOT (public.app_is_tenant_admin() OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'lift_ban: tenant admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'lift_ban: reason' USING ERRCODE = 'AE801', DETAIL = 'reason_required';
  END IF;
  SELECT * INTO v_ban FROM public.bans b
  WHERE b.id = p_ban_id AND b.status_code = 'active'
    AND (b.tenant_id = public.current_tenant_id() OR public.is_platform_admin())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lift_ban: no active ban' USING ERRCODE = 'AE802';
  END IF;
  PERFORM public.ban_end(v_ban.id, public.current_user_id(), btrim(p_reason), 'ban_lifted');
  RETURN QUERY SELECT v_ban.user_id, v_ban.tenant_id, v_ban.reference_code;
END
$$;
--> statement-breakpoint

-- System job: bans and blacklist entries past their end become 'expired'.
-- Returns whom to notify and whose cached state to clear.
CREATE OR REPLACE FUNCTION public.expire_bans(p_limit integer)
RETURNS TABLE (kind text, id uuid, user_id uuid, tenant_id uuid, reference_code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'expire_bans: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT b.id FROM public.bans b
      WHERE b.status_code = 'active' AND NOT b.is_permanent AND b.expires_at <= now()
      ORDER BY b.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    UPDATE public.bans b SET status_code = 'expired' FROM due WHERE b.id = due.id
    RETURNING 'area'::text, b.id, b.user_id, b.tenant_id, b.reference_code;
  RETURN QUERY
    WITH due AS (
      SELECT be.id FROM public.blacklist_entries be
      WHERE be.status_code = 'active' AND be.expires_at <= now()
      ORDER BY be.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    UPDATE public.blacklist_entries be SET status_code = 'expired' FROM due WHERE be.id = due.id
    RETURNING 'platform'::text, be.id, be.user_id, NULL::uuid, be.reference_code;
END
$$;
--> statement-breakpoint

-- The area's bans for its staff (newest first), with the person's name.
CREATE OR REPLACE FUNCTION public.ban_list_page(p_active_only boolean, p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, reference_code text, user_id uuid, display_name text, severity_code text, reason_code text,
               reason_text text, evidence_refs jsonb, is_permanent boolean, starts_at timestamptz,
               expires_at timestamptz, escalation_step smallint, status_code text, banned_by_name text,
               revoke_reason text, open_appeal boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.id, b.reference_code, b.user_id, up.display_name, b.severity_code, b.reason_code, b.reason_text,
         b.evidence_refs, b.is_permanent, b.starts_at, b.expires_at, b.escalation_step, b.status_code,
         bp.display_name, b.revoke_reason,
         EXISTS (SELECT 1 FROM public.ban_appeals ba WHERE ba.ban_id = b.id
                 AND ba.status_code IN ('submitted', 'in_review', 'escalated'))
  FROM public.bans b
  LEFT JOIN public.user_profiles up ON up.user_id = b.user_id
  LEFT JOIN public.user_profiles bp ON bp.user_id = b.banned_by_user_id
  WHERE b.tenant_id = public.current_tenant_id()
    AND (public.app_is_staff() OR public.is_platform_admin())
    AND (NOT p_active_only OR b.status_code = 'active')
    AND (p_after IS NULL OR b.id < p_after)
  ORDER BY b.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Staff find a member of their area by exact phone (to ban or recommend);
-- the phone itself is never returned.
CREATE OR REPLACE FUNCTION public.ban_find_member(p_phone text)
RETURNS TABLE (user_id uuid, display_name text, role_code text, ban_severity_code text, prior_bans integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, up.display_name, tm.role_code, tm.ban_severity_code,
         (SELECT count(*)::integer FROM public.bans b
          WHERE b.tenant_id = tm.tenant_id AND b.user_id = u.id AND b.status_code <> 'revoked')
  FROM public.users u
  JOIN public.tenant_members tm ON tm.user_id = u.id AND tm.tenant_id = public.current_tenant_id()
  LEFT JOIN public.user_profiles up ON up.user_id = u.id
  WHERE u.phone_e164 = p_phone AND u.deleted_at IS NULL
    AND (public.app_is_staff() OR public.is_platform_admin())
$$;
--> statement-breakpoint

-- ============================================================================
-- Appeals (§9.9)
-- ============================================================================

-- Who hears about an appeal or a recommendation: an area's admins, or the
-- platform admins. Staff, platform and system only.
CREATE OR REPLACE FUNCTION public.ban_staff_recipients(p_kind text, p_tenant_id uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT tm.user_id FROM public.tenant_members tm
  JOIN public.users u ON u.id = tm.user_id AND u.deleted_at IS NULL
  WHERE p_kind = 'area_admins' AND tm.tenant_id = p_tenant_id
    AND tm.role_code IN ('tenant_admin', 'partner_owner') AND tm.status_code = 'active'
    AND (public.app_is_system() OR public.app_is_staff() OR public.app_is_platform())
  UNION
  SELECT u.id FROM public.users u
  WHERE p_kind = 'platform_admins' AND u.platform_role_code = 'platform_admin'
    AND u.status_code = 'active' AND u.deleted_at IS NULL
    AND (public.app_is_system() OR public.app_is_staff() OR public.app_is_platform())
$$;
--> statement-breakpoint

-- Shared by both paths: checks, the per-phone daily limit, routing.
CREATE OR REPLACE FUNCTION public.appeal_create(
  p_user_id uuid, p_phone text, p_ban_id uuid, p_entry_id uuid, p_statement text, p_channel text,
  p_ip inet, p_user_agent text
)
RETURNS TABLE (id uuid, public_reference text, queue_code text, status_code text, tenant_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid;
  v_today integer;
  v_appeal public.ban_appeals%ROWTYPE;
BEGIN
  IF p_statement IS NULL OR btrim(p_statement) = ''
     OR char_length(p_statement) > public.ban_setting_int('appeal_statement_max_length', NULL) THEN
    RAISE EXCEPTION 'appeal: statement' USING ERRCODE = 'AE803', DETAIL = 'statement';
  END IF;
  IF p_ban_id IS NOT NULL THEN
    SELECT b.tenant_id INTO v_tenant FROM public.bans b
    WHERE b.id = p_ban_id AND b.user_id = p_user_id AND b.status_code = 'active'
      AND (b.is_permanent OR b.expires_at > now());
    IF NOT FOUND THEN
      RAISE EXCEPTION 'appeal: not appealable' USING ERRCODE = 'AE803', DETAIL = 'not_appealable';
    END IF;
  ELSE
    PERFORM 1 FROM public.blacklist_entries be
    WHERE be.id = p_entry_id AND be.user_id = p_user_id AND be.status_code = 'active' AND be.severity_code <> 'watch';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'appeal: not appealable' USING ERRCODE = 'AE803', DETAIL = 'not_appealable';
    END IF;
  END IF;
  -- One appeal per ban (an upheld one is final).
  PERFORM 1 FROM public.ban_appeals ba
  WHERE (p_ban_id IS NOT NULL AND ba.ban_id = p_ban_id) OR (p_entry_id IS NOT NULL AND ba.blacklist_entry_id = p_entry_id);
  IF FOUND THEN
    RAISE EXCEPTION 'appeal: already appealed' USING ERRCODE = 'AE803', DETAIL = 'already_appealed';
  END IF;
  -- appeal_rate_limit_per_day per phone, per Dhaka calendar day.
  PERFORM pg_advisory_xact_lock(hashtext('appeal:' || p_phone));
  SELECT count(*) INTO v_today FROM public.ban_appeals ba
  WHERE ba.submitted_phone_e164 = p_phone AND ba.submitted_on = (now() AT TIME ZONE 'Asia/Dhaka')::date;
  IF v_today >= public.ban_setting_int('appeal_rate_limit_per_day', NULL) THEN
    RAISE EXCEPTION 'appeal: rate limited' USING ERRCODE = 'AE803', DETAIL = 'rate_limited';
  END IF;

  INSERT INTO public.ban_appeals (public_reference, user_id, ban_id, blacklist_entry_id, channel_code,
                                  submitted_phone_e164, statement, queue_code, escalate_at, ip_address, user_agent)
  VALUES (public.ban_reference('AP'), p_user_id, p_ban_id, p_entry_id, p_channel, p_phone, btrim(p_statement),
          CASE WHEN p_ban_id IS NOT NULL THEN 'tenant_admin' ELSE 'platform' END,
          CASE WHEN p_ban_id IS NOT NULL
               THEN now() + make_interval(days => public.ban_setting_int('appeal_escalation_days', v_tenant)) END,
          p_ip, p_user_agent)
  RETURNING * INTO v_appeal;
  RETURN QUERY SELECT v_appeal.id, v_appeal.public_reference, v_appeal.queue_code, v_appeal.status_code, v_tenant;
END
$$;
--> statement-breakpoint

-- In-app (restricted/banned session): the caller's own ban or entry, by id.
CREATE OR REPLACE FUNCTION public.appeal_submit_in_app(p_target_id uuid, p_statement text)
RETURNS TABLE (id uuid, public_reference text, queue_code text, status_code text, tenant_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := public.current_user_id();
  v_phone text;
  v_is_ban boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'appeal: signed in only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT u.phone_e164 INTO v_phone FROM public.users u WHERE u.id = v_user;
  v_is_ban := EXISTS (SELECT 1 FROM public.bans b WHERE b.id = p_target_id);
  RETURN QUERY SELECT * FROM public.appeal_create(
    v_user, v_phone, CASE WHEN v_is_ban THEN p_target_id END, CASE WHEN NOT v_is_ban THEN p_target_id END,
    p_statement, 'in_app', NULL, NULL);
END
$$;
--> statement-breakpoint

-- The caller's appeals (in-app history), newest first.
CREATE OR REPLACE FUNCTION public.my_appeals()
RETURNS TABLE (id uuid, public_reference text, status_code text, target_reference text, submitted_at timestamptz,
               decided_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ba.id, ba.public_reference,
         -- The person sees "waiting" until it is final: an escalation is internal.
         CASE WHEN ba.status_code IN ('in_review', 'escalated') THEN 'submitted' ELSE ba.status_code END,
         coalesce(b.reference_code, be.reference_code), ba.submitted_at, ba.decided_at
  FROM public.ban_appeals ba
  LEFT JOIN public.bans b ON b.id = ba.ban_id
  LEFT JOIN public.blacklist_entries be ON be.id = ba.blacklist_entry_id
  WHERE ba.user_id = public.current_user_id()
  ORDER BY ba.id DESC
$$;
--> statement-breakpoint

-- The public path (§9.10). The API checks the OTP first and runs these as
-- app.role = 'appeal_public'; no session exists. Unknown phones simply
-- return nothing.
CREATE OR REPLACE FUNCTION public.public_appeal_status(p_phone text)
RETURNS TABLE (
  kind text, id uuid, reference_code text, severity_code text, reason_code text,
  area_name_bn text, area_name_en text, starts_at timestamptz, expires_at timestamptz, is_permanent boolean,
  appeal_id uuid, appeal_reference text, appeal_status text, can_appeal boolean, appeals_left_today integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT n.kind, n.id, n.reference_code, n.severity_code, n.reason_code, n.area_name_bn, n.area_name_en,
         n.starts_at, n.expires_at, n.is_permanent, n.appeal_id, n.appeal_reference,
         CASE WHEN n.appeal_status IN ('in_review', 'escalated') THEN 'submitted' ELSE n.appeal_status END,
         n.can_appeal,
         greatest(0, public.ban_setting_int('appeal_rate_limit_per_day', NULL) - (
           SELECT count(*)::integer FROM public.ban_appeals ba
           WHERE ba.submitted_phone_e164 = p_phone AND ba.submitted_on = (now() AT TIME ZONE 'Asia/Dhaka')::date))
  FROM public.users u
  CROSS JOIN LATERAL public.ban_notices_for(u.id) n
  WHERE public.app_role() = 'appeal_public' AND u.phone_e164 = p_phone AND u.deleted_at IS NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.public_appeal_submit(
  p_phone text, p_reference text, p_statement text, p_ip inet, p_user_agent text
)
RETURNS TABLE (id uuid, public_reference text, queue_code text, status_code text, tenant_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_ban uuid;
  v_entry uuid;
BEGIN
  IF public.app_role() <> 'appeal_public' THEN
    RAISE EXCEPTION 'public appeal: wrong scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT u.id INTO v_user FROM public.users u WHERE u.phone_e164 = p_phone AND u.deleted_at IS NULL;
  SELECT b.id INTO v_ban FROM public.bans b WHERE b.user_id = v_user AND b.reference_code = upper(btrim(p_reference));
  SELECT be.id INTO v_entry FROM public.blacklist_entries be
  WHERE be.user_id = v_user AND be.reference_code = upper(btrim(p_reference));
  IF v_user IS NULL OR (v_ban IS NULL AND v_entry IS NULL) THEN
    RAISE EXCEPTION 'public appeal: not appealable' USING ERRCODE = 'AE803', DETAIL = 'not_appealable';
  END IF;
  RETURN QUERY SELECT * FROM public.appeal_create(v_user, p_phone, v_ban, v_entry, p_statement, 'public_otp',
                                                  p_ip, p_user_agent);
END
$$;
--> statement-breakpoint

-- The queues. 'area': the current area's admins see appeals of their area's
-- bans still in their queue. 'platform': escalated area appeals and every
-- global one. Staff see the internal reason and evidence.
CREATE OR REPLACE FUNCTION public.appeal_queue_page(p_scope text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid, public_reference text, status_code text, queue_code text, channel_code text, statement text,
  submitted_at timestamptz, escalate_at timestamptz, escalated_at timestamptz, escalation_reason text,
  tenant_recommendation text, tenant_note text, kind text, target_id uuid, target_reference text,
  severity_code text, reason_code text, reason_text text, evidence_refs jsonb, is_permanent boolean,
  expires_at timestamptz, area_name_bn text, appellant_user_id uuid, appellant_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ba.id, ba.public_reference, ba.status_code, ba.queue_code, ba.channel_code, ba.statement,
         ba.submitted_at, ba.escalate_at, ba.escalated_at, ba.escalation_reason, ba.tenant_recommendation,
         ba.tenant_note,
         CASE WHEN ba.ban_id IS NOT NULL THEN 'area' ELSE 'platform' END,
         coalesce(ba.ban_id, ba.blacklist_entry_id), coalesce(b.reference_code, be.reference_code),
         coalesce(b.severity_code, be.severity_code), coalesce(b.reason_code, be.reason_code),
         coalesce(b.reason_text, be.summary), coalesce(b.evidence_refs, be.evidence_refs),
         coalesce(b.is_permanent, be.expires_at IS NULL), coalesce(b.expires_at, be.expires_at),
         t.name_bn, ba.user_id, up.display_name
  FROM public.ban_appeals ba
  LEFT JOIN public.bans b ON b.id = ba.ban_id
  LEFT JOIN public.blacklist_entries be ON be.id = ba.blacklist_entry_id
  LEFT JOIN public.tenants t ON t.id = coalesce(b.tenant_id, be.source_tenant_id)
  LEFT JOIN public.user_profiles up ON up.user_id = ba.user_id
  WHERE ba.status_code IN ('submitted', 'in_review', 'escalated')
    AND (
      (p_scope = 'area' AND ba.queue_code = 'tenant_admin' AND b.tenant_id = public.current_tenant_id()
       AND public.app_is_tenant_admin())
      OR (p_scope = 'platform' AND ba.queue_code = 'platform' AND public.app_is_platform())
    )
    AND (p_after IS NULL OR ba.id > p_after)
  ORDER BY ba.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Decide an appeal. The area that issued a ban is never its final judge:
-- its admins may grant or reduce (in the person's favour, final), but their
-- "uphold" only recommends it and moves the appeal to the platform. On the
-- platform queue only platform_admin decides, finally.
CREATE OR REPLACE FUNCTION public.decide_appeal(
  p_appeal_id uuid, p_decision text, p_note text, p_reduced_until timestamptz
)
RETURNS TABLE (status_code text, user_id uuid, public_reference text, tenant_id uuid, kind text,
               replacement_reference text, replacement_until timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_actor uuid := public.current_user_id();
  v_appeal public.ban_appeals%ROWTYPE;
  v_ban public.bans%ROWTYPE;
  v_entry public.blacklist_entries%ROWTYPE;
  v_platform boolean := public.is_platform_admin() AND public.app_role() = 'platform_admin';
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status text;
  v_new_ban public.bans%ROWTYPE;
  v_new_entry public.blacklist_entries%ROWTYPE;
  v_action text;
  v_tenant uuid;
BEGIN
  SELECT * INTO v_appeal FROM public.ban_appeals ba
  WHERE ba.id = p_appeal_id AND ba.status_code IN ('submitted', 'in_review', 'escalated')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_appeal: no open appeal' USING ERRCODE = 'AE804', DETAIL = 'not_found';
  END IF;
  IF v_appeal.ban_id IS NOT NULL THEN
    SELECT * INTO v_ban FROM public.bans b WHERE b.id = v_appeal.ban_id FOR UPDATE;
    v_tenant := v_ban.tenant_id;
  ELSE
    SELECT * INTO v_entry FROM public.blacklist_entries be WHERE be.id = v_appeal.blacklist_entry_id FOR UPDATE;
    v_tenant := v_entry.source_tenant_id;
  END IF;

  -- Whose turn is it.
  IF v_appeal.queue_code = 'platform' THEN
    IF NOT v_platform THEN
      RAISE EXCEPTION 'decide_appeal: platform queue' USING ERRCODE = 'AE804', DETAIL = 'not_your_queue';
    END IF;
  ELSIF NOT v_platform THEN
    IF NOT public.app_is_tenant_admin() OR v_ban.tenant_id IS DISTINCT FROM public.current_tenant_id() THEN
      RAISE EXCEPTION 'decide_appeal: not your area' USING ERRCODE = 'AE804', DETAIL = 'not_your_queue';
    END IF;
  END IF;
  IF v_appeal.user_id = v_actor THEN
    RAISE EXCEPTION 'decide_appeal: own appeal' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_decision = 'grant' THEN
    v_status := 'granted';
    v_action := 'appeal_granted';
    IF v_ban.id IS NOT NULL THEN
      PERFORM public.ban_end(v_ban.id, v_actor, 'appeal ' || v_appeal.public_reference || coalesce(': ' || v_note, ''),
                             'appeal_granted');
    ELSE
      UPDATE public.blacklist_entries be SET status_code = 'revoked', revoked_at = now(),
        revoke_reason = 'appeal ' || v_appeal.public_reference || coalesce(': ' || v_note, '')
      WHERE be.id = v_entry.id;
    END IF;
  ELSIF p_decision = 'reduce' THEN
    v_status := 'reduced';
    v_action := 'appeal_reduced';
    IF p_reduced_until IS NULL OR p_reduced_until <= now()
       OR (v_ban.id IS NOT NULL AND NOT v_ban.is_permanent AND p_reduced_until >= v_ban.expires_at)
       OR (v_entry.id IS NOT NULL AND v_entry.expires_at IS NOT NULL AND p_reduced_until >= v_entry.expires_at) THEN
      RAISE EXCEPTION 'decide_appeal: reduce needs an earlier end' USING ERRCODE = 'AE804', DETAIL = 'reduce_until';
    END IF;
    IF v_ban.id IS NOT NULL THEN
      PERFORM public.ban_end(v_ban.id, v_actor, 'appeal ' || v_appeal.public_reference || coalesce(': ' || v_note, ''),
                             'appeal_reduced');
      INSERT INTO public.bans (tenant_id, user_id, severity_code, reason_code, reason_text, evidence_refs,
                               banned_by_user_id, is_permanent, expires_at, escalation_step,
                               ladder_override_reason, previous_ban_id)
      VALUES (v_ban.tenant_id, v_ban.user_id, v_ban.severity_code, v_ban.reason_code, v_ban.reason_text,
              v_ban.evidence_refs, v_actor, false, p_reduced_until, v_ban.escalation_step,
              'appeal ' || v_appeal.public_reference, v_ban.id)
      RETURNING * INTO v_new_ban;
    ELSE
      UPDATE public.blacklist_entries be SET status_code = 'revoked', revoked_at = now(),
        revoke_reason = 'appeal ' || v_appeal.public_reference || ' (reduced)'
      WHERE be.id = v_entry.id;
      INSERT INTO public.blacklist_entries (user_id, phone_e164, phone_hash, document_number_hash,
        device_fingerprint_hash, reason_code, severity_code, status_code, summary, source_tenant_id,
        source_report_id, recommended_by_user_id, evidence_refs, reviewed_by_user_id, reviewed_at, expires_at,
        review_note)
      VALUES (v_entry.user_id, v_entry.phone_e164, v_entry.phone_hash, v_entry.document_number_hash,
        v_entry.device_fingerprint_hash, v_entry.reason_code, v_entry.severity_code, 'active', v_entry.summary,
        v_entry.source_tenant_id, v_entry.source_report_id, v_entry.recommended_by_user_id, v_entry.evidence_refs,
        v_actor, v_entry.reviewed_at, p_reduced_until, 'appeal ' || v_appeal.public_reference)
      RETURNING * INTO v_new_entry;
    END IF;
  ELSIF p_decision = 'uphold' THEN
    IF NOT v_platform THEN
      -- The area recommends; the platform decides.
      IF v_note IS NULL THEN
        RAISE EXCEPTION 'decide_appeal: say why' USING ERRCODE = 'AE804', DETAIL = 'note_required';
      END IF;
      UPDATE public.ban_appeals ba SET status_code = 'escalated', queue_code = 'platform', escalated_at = now(),
        escalation_reason = 'tenant_upheld', tenant_recommendation = 'uphold', tenant_note = v_note,
        tenant_reviewed_by_user_id = v_actor, tenant_reviewed_at = now()
      WHERE ba.id = v_appeal.id;
      INSERT INTO public.moderation_actions (tenant_id, ban_id, actor_user_id, action_code, reason_code, reason_text)
      VALUES (v_ban.tenant_id, v_ban.id, v_actor, 'appeal_escalated', 'ban_appeal',
              'appeal ' || v_appeal.public_reference || ': ' || v_note);
      RETURN QUERY SELECT 'escalated'::text, v_appeal.user_id, v_appeal.public_reference, v_tenant, 'area'::text,
                          NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    v_status := 'upheld';
    v_action := 'appeal_upheld';
  ELSE
    RAISE EXCEPTION 'decide_appeal: decision %', p_decision USING ERRCODE = 'AE804', DETAIL = 'decision';
  END IF;

  UPDATE public.ban_appeals ba SET status_code = v_status, decided_by_user_id = v_actor, decided_at = now(),
    decision_note = v_note, replacement_ban_id = v_new_ban.id, replacement_blacklist_entry_id = v_new_entry.id,
    tenant_reviewed_by_user_id = CASE WHEN v_platform THEN ba.tenant_reviewed_by_user_id ELSE v_actor END,
    tenant_reviewed_at = CASE WHEN v_platform THEN ba.tenant_reviewed_at ELSE now() END
  WHERE ba.id = v_appeal.id;

  -- Rule 13: the decision's audit row (grant and reduce on a ban wrote theirs in ban_end).
  IF v_ban.id IS NOT NULL AND v_status = 'upheld' THEN
    INSERT INTO public.moderation_actions (tenant_id, ban_id, actor_user_id, action_code, reason_code, reason_text)
    VALUES (v_ban.tenant_id, v_ban.id, v_actor, v_action, 'ban_appeal',
            'appeal ' || v_appeal.public_reference || coalesce(': ' || v_note, ''));
  ELSIF v_entry.id IS NOT NULL THEN
    IF v_entry.source_tenant_id IS NOT NULL THEN
      INSERT INTO public.moderation_actions (tenant_id, blacklist_entry_id, actor_user_id, action_code, reason_code,
                                             reason_text)
      VALUES (v_entry.source_tenant_id, v_entry.id, v_actor, v_action, 'ban_appeal',
              'appeal ' || v_appeal.public_reference || coalesce(': ' || v_note, ''));
    END IF;
    INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, entity_table, entity_id, changes, reason)
    VALUES (NULL, v_actor, 'platform_admin', replace(v_action, '_', '.'), 'blacklist_entries', v_entry.id,
            jsonb_build_object('appeal', v_appeal.public_reference, 'replacement', v_new_entry.id), v_note);
  END IF;

  RETURN QUERY SELECT v_status, v_appeal.user_id, v_appeal.public_reference, v_tenant,
                      CASE WHEN v_ban.id IS NOT NULL THEN 'area' ELSE 'platform' END,
                      coalesce(v_new_ban.reference_code, v_new_entry.reference_code),
                      coalesce(v_new_ban.expires_at, v_new_entry.expires_at);
END
$$;
--> statement-breakpoint

-- System job: an area that hasn't decided by escalate_at loses the appeal
-- to the platform.
CREATE OR REPLACE FUNCTION public.escalate_due_appeals(p_limit integer)
RETURNS TABLE (id uuid, public_reference text, tenant_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'escalate_due_appeals: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT ba.id FROM public.ban_appeals ba
      WHERE ba.queue_code = 'tenant_admin' AND ba.status_code IN ('submitted', 'in_review')
        AND ba.escalate_at <= now()
      ORDER BY ba.escalate_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    UPDATE public.ban_appeals ba SET queue_code = 'platform', status_code = 'escalated', escalated_at = now(),
      escalation_reason = 'timeout'
    FROM due WHERE ba.id = due.id
    RETURNING ba.id, ba.public_reference, (SELECT b.tenant_id FROM public.bans b WHERE b.id = ba.ban_id);
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Global blacklist governance (§9.6)
-- ============================================================================

-- A tenant admin recommends; nothing else. The person must be a member of
-- the area; one pending recommendation per person.
CREATE OR REPLACE FUNCTION public.recommend_blacklist(
  p_user_id uuid, p_reason_code text, p_severity text, p_summary text, p_evidence jsonb, p_expires_at timestamptz
)
RETURNS TABLE (id uuid, reference_code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_actor uuid := public.current_user_id();
  v_entry public.blacklist_entries%ROWTYPE;
BEGIN
  IF NOT public.app_is_tenant_admin() OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'recommend_blacklist: tenant admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'recommend_blacklist: self' USING ERRCODE = 'AE805', DETAIL = 'self';
  END IF;
  PERFORM 1 FROM public.tenant_members tm WHERE tm.tenant_id = v_tenant AND tm.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recommend_blacklist: not a member' USING ERRCODE = 'AE805', DETAIL = 'not_member';
  END IF;
  IF p_severity NOT IN ('watch', 'restricted', 'banned', 'terminated') THEN
    RAISE EXCEPTION 'recommend_blacklist: severity' USING ERRCODE = 'AE805', DETAIL = 'severity';
  END IF;
  IF p_summary IS NULL OR btrim(p_summary) = '' THEN
    RAISE EXCEPTION 'recommend_blacklist: summary' USING ERRCODE = 'AE805', DETAIL = 'summary_required';
  END IF;
  IF NOT public.ban_evidence_valid(coalesce(p_evidence, '[]'::jsonb))
     OR jsonb_array_length(coalesce(p_evidence, '[]'::jsonb)) < 1 THEN
    RAISE EXCEPTION 'recommend_blacklist: evidence' USING ERRCODE = 'AE805', DETAIL = 'evidence_required';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'recommend_blacklist: expiry' USING ERRCODE = 'AE805', DETAIL = 'expiry';
  END IF;
  IF EXISTS (SELECT 1 FROM public.blacklist_entries be WHERE be.user_id = p_user_id AND be.status_code = 'recommended') THEN
    RAISE EXCEPTION 'recommend_blacklist: pending' USING ERRCODE = 'AE805', DETAIL = 'open_recommendation';
  END IF;
  INSERT INTO public.blacklist_entries (user_id, reason_code, severity_code, status_code, summary, source_tenant_id,
                                        recommended_by_user_id, evidence_refs, expires_at)
  VALUES (p_user_id, p_reason_code, p_severity, 'recommended', btrim(p_summary), v_tenant, v_actor,
          p_evidence, p_expires_at)
  RETURNING * INTO v_entry;
  INSERT INTO public.moderation_actions (tenant_id, blacklist_entry_id, actor_user_id, action_code, reason_code,
                                         reason_text, evidence_refs)
  VALUES (v_tenant, v_entry.id, v_actor, 'blacklist_recommended', 'blacklist_review',
          p_severity || ' / ' || p_reason_code || ': ' || btrim(p_summary), p_evidence);
  RETURN QUERY SELECT v_entry.id, v_entry.reference_code;
END
$$;
--> statement-breakpoint

-- The platform's queue (recommended) or an area's own recommendations.
CREATE OR REPLACE FUNCTION public.blacklist_page(p_scope text, p_status text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid, reference_code text, user_id uuid, display_name text, reason_code text, severity_code text,
  status_code text, summary text, evidence_refs jsonb, expires_at timestamptz, source_area_name_bn text,
  recommended_by_name text, created_at timestamptz, reviewed_at timestamptz, review_note text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT be.id, be.reference_code, be.user_id, up.display_name, be.reason_code, be.severity_code, be.status_code,
         be.summary, be.evidence_refs, be.expires_at, t.name_bn, rp.display_name, be.created_at, be.reviewed_at,
         be.review_note
  FROM public.blacklist_entries be
  LEFT JOIN public.user_profiles up ON up.user_id = be.user_id
  LEFT JOIN public.user_profiles rp ON rp.user_id = be.recommended_by_user_id
  LEFT JOIN public.tenants t ON t.id = be.source_tenant_id
  WHERE (p_status IS NULL OR be.status_code = p_status)
    AND (
      (p_scope = 'platform' AND public.app_is_platform())
      OR (p_scope = 'area' AND public.app_is_tenant_admin() AND be.source_tenant_id = public.current_tenant_id())
    )
    AND (p_after IS NULL OR be.id < p_after)
  ORDER BY be.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint

-- The phone of the person on a pending entry, so the API can hash it
-- (HMAC, server-side pepper) for approval. platform_admin only; the number
-- never leaves the API.
CREATE OR REPLACE FUNCTION public.blacklist_subject_phone(p_entry_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.phone_e164 FROM public.blacklist_entries be JOIN public.users u ON u.id = be.user_id
  WHERE be.id = p_entry_id AND public.is_platform_admin() AND public.app_role() = 'platform_admin'
$$;
--> statement-breakpoint

-- platform_admin approves (the entry becomes active everywhere at once) or
-- rejects. An approved 'terminated' entry revokes every session of the person.
CREATE OR REPLACE FUNCTION public.decide_blacklist(p_entry_id uuid, p_decision text, p_note text, p_phone_hash text)
RETURNS TABLE (status_code text, user_id uuid, severity_code text, reference_code text, source_tenant_id uuid,
               expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_actor uuid := public.current_user_id();
  v_entry public.blacklist_entries%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_action text;
BEGIN
  IF NOT (public.is_platform_admin() AND public.app_role() = 'platform_admin') THEN
    RAISE EXCEPTION 'decide_blacklist: platform admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_entry FROM public.blacklist_entries be
  WHERE be.id = p_entry_id AND be.status_code = 'recommended' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_blacklist: not pending' USING ERRCODE = 'AE805', DETAIL = 'not_found';
  END IF;
  IF v_entry.recommended_by_user_id = v_actor THEN
    RAISE EXCEPTION 'decide_blacklist: own recommendation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision = 'approve' THEN
    IF p_phone_hash IS NOT NULL AND p_phone_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'decide_blacklist: phone hash' USING ERRCODE = 'AE805', DETAIL = 'phone_hash';
    END IF;
    UPDATE public.blacklist_entries be SET status_code = 'active', reviewed_by_user_id = v_actor, reviewed_at = now(),
      review_note = v_note, phone_hash = coalesce(p_phone_hash, be.phone_hash)
    WHERE be.id = v_entry.id;
    v_action := 'blacklist_approved';
    IF v_entry.severity_code = 'terminated' AND v_entry.user_id IS NOT NULL THEN
      UPDATE public.auth_refresh_tokens rt SET revoked_at = now()
      WHERE rt.user_id = v_entry.user_id AND rt.revoked_at IS NULL;
    END IF;
  ELSIF p_decision = 'reject' THEN
    IF v_note IS NULL THEN
      RAISE EXCEPTION 'decide_blacklist: say why' USING ERRCODE = 'AE805', DETAIL = 'note_required';
    END IF;
    UPDATE public.blacklist_entries be SET status_code = 'rejected', reviewed_by_user_id = v_actor, reviewed_at = now(),
      review_note = v_note
    WHERE be.id = v_entry.id;
    v_action := 'blacklist_rejected';
  ELSE
    RAISE EXCEPTION 'decide_blacklist: decision %', p_decision USING ERRCODE = 'AE805', DETAIL = 'decision';
  END IF;
  IF v_entry.source_tenant_id IS NOT NULL THEN
    INSERT INTO public.moderation_actions (tenant_id, blacklist_entry_id, actor_user_id, action_code, reason_code,
                                           reason_text)
    VALUES (v_entry.source_tenant_id, v_entry.id, v_actor, v_action, 'blacklist_review', v_note);
  END IF;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, entity_table, entity_id, changes, reason)
  VALUES (NULL, v_actor, 'platform_admin', replace(v_action, '_', '.'), 'blacklist_entries', v_entry.id,
          jsonb_build_object('severity', v_entry.severity_code, 'user_id', v_entry.user_id), v_note);
  RETURN QUERY SELECT be.status_code, be.user_id, be.severity_code, be.reference_code, be.source_tenant_id,
                      be.expires_at
               FROM public.blacklist_entries be WHERE be.id = v_entry.id;
END
$$;
--> statement-breakpoint

-- platform_admin lifts an active entry.
CREATE OR REPLACE FUNCTION public.revoke_blacklist(p_entry_id uuid, p_reason text)
RETURNS TABLE (user_id uuid, reference_code text, source_tenant_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_actor uuid := public.current_user_id();
  v_entry public.blacklist_entries%ROWTYPE;
BEGIN
  IF NOT (public.is_platform_admin() AND public.app_role() = 'platform_admin') THEN
    RAISE EXCEPTION 'revoke_blacklist: platform admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'revoke_blacklist: reason' USING ERRCODE = 'AE805', DETAIL = 'note_required';
  END IF;
  UPDATE public.blacklist_entries be SET status_code = 'revoked', revoked_at = now(), revoke_reason = btrim(p_reason)
  WHERE be.id = p_entry_id AND be.status_code = 'active'
  RETURNING * INTO v_entry;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'revoke_blacklist: not active' USING ERRCODE = 'AE805', DETAIL = 'not_found';
  END IF;
  IF v_entry.source_tenant_id IS NOT NULL THEN
    INSERT INTO public.moderation_actions (tenant_id, blacklist_entry_id, actor_user_id, action_code, reason_code,
                                           reason_text)
    VALUES (v_entry.source_tenant_id, v_entry.id, v_actor, 'blacklist_revoked', 'blacklist_review', btrim(p_reason));
  END IF;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, entity_table, entity_id, reason)
  VALUES (NULL, v_actor, 'platform_admin', 'blacklist.revoked', 'blacklist_entries', v_entry.id, btrim(p_reason));
  RETURN QUERY SELECT v_entry.user_id, v_entry.reference_code, v_entry.source_tenant_id;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Complaints
-- ============================================================================

-- Staff who can work complaints in the current area.
CREATE OR REPLACE FUNCTION public.complaint_can_work()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT public.app_is_staff() OR public.app_role() = 'executive' OR public.is_platform_admin()
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.complaint_due_at(p_from timestamptz, p_priority text, p_tenant_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_from + make_interval(hours => public.ban_setting_int(cp.sla_setting_key, p_tenant_id))
  FROM public.complaint_priorities cp WHERE cp.code = p_priority
$$;
--> statement-breakpoint

-- The author of a post a member could have seen (live, sold, expired): a
-- complaint about "the person on this post" names no user id on the client.
CREATE OR REPLACE FUNCTION public.complaint_post_author(p_post_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT tm.user_id
  FROM public.posts p
  JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.id = p.author_member_id
  WHERE p.id = p_post_id AND p.status_code IN ('live', 'sold', 'expired') AND p.deleted_at IS NULL
    AND public.current_user_id() IS NOT NULL
$$;
--> statement-breakpoint

-- A member's complaint about a person or a store of the current area (the
-- API runs it in the subject's area). No membership needed to complain.
CREATE OR REPLACE FUNCTION public.submit_complaint(
  p_subject_type text, p_subject_id uuid, p_category text, p_description text, p_evidence jsonb
)
RETURNS TABLE (id uuid, reference_code text, status_code text, priority_code text, due_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := public.current_user_id();
  v_subject_user uuid;
  v_priority text;
  v_today integer;
  v_row public.complaints%ROWTYPE;
BEGIN
  IF v_user IS NULL OR v_tenant IS NULL OR NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'submit_complaint: signed-in members only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_subject_type = 'user' THEN
    SELECT tm.user_id INTO v_subject_user FROM public.tenant_members tm
    WHERE tm.tenant_id = v_tenant AND tm.user_id = p_subject_id;
  ELSIF p_subject_type = 'store' THEN
    SELECT tm.user_id INTO v_subject_user FROM public.stores s
    JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.id = s.owner_member_id
    WHERE s.id = p_subject_id AND s.tenant_id = v_tenant;
  END IF;
  IF v_subject_user IS NULL THEN
    RAISE EXCEPTION 'submit_complaint: no such subject here' USING ERRCODE = 'AE806', DETAIL = 'subject_not_found';
  END IF;
  IF v_subject_user = v_user THEN
    RAISE EXCEPTION 'submit_complaint: self' USING ERRCODE = 'AE806', DETAIL = 'self';
  END IF;
  SELECT cc.default_priority_code INTO v_priority FROM public.complaint_categories cc
  WHERE cc.code = p_category AND cc.is_active;
  IF v_priority IS NULL THEN
    RAISE EXCEPTION 'submit_complaint: category' USING ERRCODE = 'AE806', DETAIL = 'category';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = ''
     OR char_length(p_description) > public.ban_setting_int('complaint_description_max_length', v_tenant) THEN
    RAISE EXCEPTION 'submit_complaint: description' USING ERRCODE = 'AE806', DETAIL = 'description';
  END IF;
  IF NOT public.ban_evidence_valid(coalesce(p_evidence, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'submit_complaint: evidence' USING ERRCODE = 'AE806', DETAIL = 'invalid_evidence';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('complaint:' || v_user));
  IF EXISTS (SELECT 1 FROM public.complaints c WHERE c.reporter_user_id = v_user AND c.subject_type = p_subject_type
             AND c.subject_id = p_subject_id AND c.status_code <> 'resolved') THEN
    RAISE EXCEPTION 'submit_complaint: already open' USING ERRCODE = 'AE806', DETAIL = 'open_complaint';
  END IF;
  SELECT count(*) INTO v_today FROM public.complaints c
  WHERE c.reporter_user_id = v_user AND c.created_at > now() - interval '1 day';
  IF v_today >= public.ban_setting_int('complaint_max_per_day', v_tenant) THEN
    RAISE EXCEPTION 'submit_complaint: rate limited' USING ERRCODE = 'AE806', DETAIL = 'rate_limited';
  END IF;
  INSERT INTO public.complaints (tenant_id, reporter_user_id, subject_type, subject_id, category_code, priority_code,
                                 description, evidence_refs, due_at)
  VALUES (v_tenant, v_user, p_subject_type, p_subject_id, p_category, v_priority, btrim(p_description),
          coalesce(p_evidence, '[]'::jsonb), public.complaint_due_at(now(), v_priority, v_tenant))
  RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.reference_code, v_row.status_code, v_row.priority_code, v_row.due_at;
END
$$;
--> statement-breakpoint

-- The reporter's own complaints, in any area. The internal resolution text
-- stays with staff.
CREATE OR REPLACE FUNCTION public.my_complaints()
RETURNS TABLE (id uuid, reference_code text, subject_type text, subject_name text, category_code text,
               status_code text, created_at timestamptz, resolved_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.reference_code, c.subject_type,
         CASE WHEN c.subject_type = 'store' THEN s.name_bn ELSE up.display_name END,
         c.category_code, c.status_code, c.created_at, c.resolved_at
  FROM public.complaints c
  LEFT JOIN public.stores s ON c.subject_type = 'store' AND s.id = c.subject_id
  LEFT JOIN public.user_profiles up ON c.subject_type = 'user' AND up.user_id = c.subject_id
  WHERE c.reporter_user_id = public.current_user_id()
  ORDER BY c.id DESC
$$;
--> statement-breakpoint

-- The area's queue: open by due time (or resolved, newest first).
CREATE OR REPLACE FUNCTION public.complaint_queue_page(p_status text, p_mine boolean, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid, reference_code text, subject_type text, subject_id uuid, subject_user_id uuid, subject_name text,
  reporter_name text, category_code text, priority_code text, status_code text, description text,
  evidence_refs jsonb, assigned_to_user_id uuid, assigned_to_name text, due_at timestamptz, overdue boolean,
  created_at timestamptz, resolution text, resolved_at timestamptz, ban_id uuid, subject_ban_severity text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.reference_code, c.subject_type, c.subject_id,
         coalesce(owner.user_id, c.subject_id),
         CASE WHEN c.subject_type = 'store' THEN s.name_bn ELSE sp.display_name END,
         rp.display_name, c.category_code, c.priority_code, c.status_code, c.description, c.evidence_refs,
         c.assigned_to_user_id, ap.display_name, c.due_at, c.status_code <> 'resolved' AND c.due_at < now(),
         c.created_at, c.resolution, c.resolved_at, c.ban_id, tm.ban_severity_code
  FROM public.complaints c
  LEFT JOIN public.stores s ON c.subject_type = 'store' AND s.id = c.subject_id
  LEFT JOIN public.tenant_members owner ON owner.tenant_id = s.tenant_id AND owner.id = s.owner_member_id
  LEFT JOIN public.user_profiles sp ON c.subject_type = 'user' AND sp.user_id = c.subject_id
  LEFT JOIN public.user_profiles rp ON rp.user_id = c.reporter_user_id
  LEFT JOIN public.user_profiles ap ON ap.user_id = c.assigned_to_user_id
  LEFT JOIN public.tenant_members tm ON tm.tenant_id = c.tenant_id
       AND tm.user_id = coalesce(owner.user_id, c.subject_id)
  WHERE c.tenant_id = public.current_tenant_id() AND public.complaint_can_work()
    AND CASE WHEN p_status IS NULL THEN c.status_code <> 'resolved' ELSE c.status_code = p_status END
    AND (NOT coalesce(p_mine, false) OR c.assigned_to_user_id = public.current_user_id())
    AND (p_after IS NULL OR c.id > p_after)
  ORDER BY c.due_at, c.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Who a complaint can be assigned to: the area's moderators, executives and admins.
CREATE OR REPLACE FUNCTION public.complaint_assignees()
RETURNS TABLE (user_id uuid, display_name text, role_code text, open_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT tm.user_id, up.display_name, tm.role_code,
         (SELECT count(*)::integer FROM public.complaints c
          WHERE c.tenant_id = tm.tenant_id AND c.assigned_to_user_id = tm.user_id AND c.status_code <> 'resolved')
  FROM public.tenant_members tm
  LEFT JOIN public.user_profiles up ON up.user_id = tm.user_id
  WHERE tm.tenant_id = public.current_tenant_id() AND public.complaint_can_work()
    AND tm.role_code IN ('moderator', 'executive', 'tenant_admin', 'partner_owner') AND tm.status_code = 'active'
  ORDER BY up.display_name
$$;
--> statement-breakpoint

-- Assign (or unassign), change priority (the SLA follows), start work.
CREATE OR REPLACE FUNCTION public.update_complaint(
  p_id uuid, p_set_assignee boolean, p_assignee uuid, p_priority text, p_status text
)
RETURNS TABLE (reference_code text, status_code text, priority_code text, assigned_to_user_id uuid,
               newly_assigned boolean, due_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_row public.complaints%ROWTYPE;
  v_new_assignee boolean := false;
BEGIN
  IF NOT public.complaint_can_work() THEN
    RAISE EXCEPTION 'update_complaint: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_row FROM public.complaints c
  WHERE c.id = p_id AND c.tenant_id = public.current_tenant_id() AND c.status_code <> 'resolved' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_complaint: no open complaint' USING ERRCODE = 'AE807', DETAIL = 'not_found';
  END IF;
  IF coalesce(p_set_assignee, false) THEN
    IF p_assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.complaint_assignees() a WHERE a.user_id = p_assignee) THEN
      RAISE EXCEPTION 'update_complaint: assignee' USING ERRCODE = 'AE807', DETAIL = 'assignee';
    END IF;
    v_new_assignee := p_assignee IS NOT NULL AND p_assignee IS DISTINCT FROM v_row.assigned_to_user_id;
    v_row.assigned_to_user_id := p_assignee;
    v_row.assigned_at := CASE WHEN p_assignee IS NULL THEN NULL WHEN v_new_assignee THEN now() ELSE v_row.assigned_at END;
  END IF;
  IF p_priority IS NOT NULL AND p_priority <> v_row.priority_code THEN
    IF NOT EXISTS (SELECT 1 FROM public.complaint_priorities cp WHERE cp.code = p_priority) THEN
      RAISE EXCEPTION 'update_complaint: priority' USING ERRCODE = 'AE807', DETAIL = 'priority';
    END IF;
    v_row.priority_code := p_priority;
    v_row.due_at := public.complaint_due_at(v_row.created_at, p_priority, v_row.tenant_id);
    v_row.sla_breached_at := NULL;
  END IF;
  IF p_status IS NOT NULL AND p_status <> v_row.status_code THEN
    IF p_status NOT IN ('pending', 'in_progress') THEN
      RAISE EXCEPTION 'update_complaint: status' USING ERRCODE = 'AE807', DETAIL = 'status';
    END IF;
    v_row.status_code := p_status;
  END IF;
  UPDATE public.complaints c SET assigned_to_user_id = v_row.assigned_to_user_id, assigned_at = v_row.assigned_at,
    priority_code = v_row.priority_code, due_at = v_row.due_at, sla_breached_at = v_row.sla_breached_at,
    status_code = v_row.status_code
  WHERE c.id = v_row.id;
  RETURN QUERY SELECT v_row.reference_code, v_row.status_code, v_row.priority_code, v_row.assigned_to_user_id,
                      v_new_assignee, v_row.due_at;
END
$$;
--> statement-breakpoint

-- Resolve with a written resolution; optionally the ban it led to (a ban
-- on the subject, in this area).
CREATE OR REPLACE FUNCTION public.resolve_complaint(p_id uuid, p_resolution text, p_ban_id uuid)
RETURNS TABLE (reporter_user_id uuid, reference_code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_row public.complaints%ROWTYPE;
  v_subject_user uuid;
BEGIN
  IF NOT public.complaint_can_work() THEN
    RAISE EXCEPTION 'resolve_complaint: staff only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_resolution IS NULL OR btrim(p_resolution) = '' THEN
    RAISE EXCEPTION 'resolve_complaint: resolution' USING ERRCODE = 'AE807', DETAIL = 'resolution_required';
  END IF;
  SELECT * INTO v_row FROM public.complaints c
  WHERE c.id = p_id AND c.tenant_id = public.current_tenant_id() AND c.status_code <> 'resolved' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_complaint: no open complaint' USING ERRCODE = 'AE807', DETAIL = 'not_found';
  END IF;
  IF p_ban_id IS NOT NULL THEN
    SELECT coalesce(tm.user_id, v_row.subject_id) INTO v_subject_user
    FROM (SELECT 1) x
    LEFT JOIN public.stores s ON v_row.subject_type = 'store' AND s.id = v_row.subject_id
    LEFT JOIN public.tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.id = s.owner_member_id;
    PERFORM 1 FROM public.bans b WHERE b.id = p_ban_id AND b.tenant_id = v_row.tenant_id AND b.user_id = v_subject_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'resolve_complaint: ban' USING ERRCODE = 'AE807', DETAIL = 'ban';
    END IF;
  END IF;
  UPDATE public.complaints c SET status_code = 'resolved', resolution = btrim(p_resolution),
    resolved_by_user_id = public.current_user_id(), resolved_at = now(), ban_id = p_ban_id
  WHERE c.id = v_row.id;
  RETURN QUERY SELECT v_row.reporter_user_id, v_row.reference_code;
END
$$;
--> statement-breakpoint

-- System job: open complaints past their due time, once each.
CREATE OR REPLACE FUNCTION public.due_complaint_sla_breaches(p_limit integer)
RETURNS TABLE (id uuid, reference_code text, tenant_id uuid, assigned_to_user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'due_complaint_sla_breaches: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT c.id FROM public.complaints c
      WHERE c.status_code <> 'resolved' AND c.sla_breached_at IS NULL AND c.due_at <= now()
      ORDER BY c.due_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    UPDATE public.complaints c SET sla_breached_at = now() FROM due WHERE c.id = due.id
    RETURNING c.id, c.reference_code, c.tenant_id, c.assigned_to_user_id;
END
$$;
--> statement-breakpoint

-- ============================================================================
-- Ownership and grants
-- ============================================================================

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.ban_setting_int(text, uuid)', 'public.my_ban_state()', 'public.ban_notices_for(uuid)',
    'public.my_ban_notices()', 'public.blacklist_match(uuid, text, text)',
    'public.issue_ban(uuid, text, text, text, jsonb, integer, boolean, text)', 'public.ban_end(uuid, uuid, text, text)',
    'public.lift_ban(uuid, text)', 'public.expire_bans(integer)', 'public.ban_list_page(boolean, uuid, integer)',
    'public.ban_find_member(text)', 'public.ban_staff_recipients(text, uuid)',
    'public.appeal_create(uuid, text, uuid, uuid, text, text, inet, text)', 'public.appeal_submit_in_app(uuid, text)',
    'public.my_appeals()', 'public.public_appeal_status(text)', 'public.public_appeal_submit(text, text, text, inet, text)',
    'public.appeal_queue_page(text, uuid, integer)', 'public.decide_appeal(uuid, text, text, timestamptz)',
    'public.escalate_due_appeals(integer)',
    'public.recommend_blacklist(uuid, text, text, text, jsonb, timestamptz)',
    'public.blacklist_page(text, text, uuid, integer)', 'public.blacklist_subject_phone(uuid)',
    'public.decide_blacklist(uuid, text, text, text)', 'public.revoke_blacklist(uuid, text)',
    'public.complaint_due_at(timestamptz, text, uuid)', 'public.submit_complaint(text, uuid, text, text, jsonb)',
    'public.complaint_post_author(uuid)',
    'public.my_complaints()', 'public.complaint_queue_page(text, boolean, uuid, integer)',
    'public.complaint_assignees()', 'public.update_complaint(uuid, boolean, uuid, text, text)',
    'public.resolve_complaint(uuid, text, uuid)', 'public.due_complaint_sla_breaches(integer)'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ae_rls_bypass', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Called by the app (each checks the caller itself).
GRANT EXECUTE ON FUNCTION
  public.my_ban_state(), public.my_ban_notices(), public.blacklist_match(uuid, text, text),
  public.issue_ban(uuid, text, text, text, jsonb, integer, boolean, text), public.lift_ban(uuid, text),
  public.expire_bans(integer), public.ban_list_page(boolean, uuid, integer), public.ban_find_member(text),
  public.ban_staff_recipients(text, uuid), public.appeal_submit_in_app(uuid, text), public.my_appeals(),
  public.public_appeal_status(text), public.public_appeal_submit(text, text, text, inet, text),
  public.appeal_queue_page(text, uuid, integer), public.decide_appeal(uuid, text, text, timestamptz),
  public.escalate_due_appeals(integer), public.recommend_blacklist(uuid, text, text, text, jsonb, timestamptz),
  public.blacklist_page(text, text, uuid, integer), public.blacklist_subject_phone(uuid),
  public.decide_blacklist(uuid, text, text, text), public.revoke_blacklist(uuid, text),
  public.submit_complaint(text, uuid, text, text, jsonb), public.complaint_post_author(uuid), public.my_complaints(),
  public.complaint_queue_page(text, boolean, uuid, integer), public.complaint_assignees(),
  public.update_complaint(uuid, boolean, uuid, text, text), public.resolve_complaint(uuid, text, uuid),
  public.due_complaint_sla_breaches(integer)
TO ae_app;
--> statement-breakpoint
-- Internal helpers, called from inside the functions above.
GRANT EXECUTE ON FUNCTION
  public.ban_setting_int(text, uuid), public.ban_notices_for(uuid), public.ban_end(uuid, uuid, text, text),
  public.appeal_create(uuid, text, uuid, uuid, text, text, inet, text), public.complaint_due_at(timestamptz, text, uuid),
  public.ban_staff_recipients(text, uuid)
TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ban_reference(text), public.ban_severity_rank(text), public.ban_evidence_valid(jsonb),
  public.complaint_can_work() TO ae_app, ae_rls_bypass;

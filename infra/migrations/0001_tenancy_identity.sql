-- 0001_tenancy_identity
--
-- Tenancy & identity domain (docs/specs/schema.md): tenants, users,
-- tenant_members, tenant_settings, blacklist_entries, audit_logs, plus the
-- enum tables their FKs need (§0.3, §12), with seed rows.
--
-- Conventions applied here:
--   * uuid v7 ids via uuid_generate_v7(); timestamptz everywhere.
--   * Explicit constraint names: <table>_<cols>_<kind> (§0.8).
--   * Every table with updated_at has a set_updated_at trigger.
--   * Enum-table FKs are ON DELETE RESTRICT and not indexed: enum rows are
--     never deleted (retired via is_active), so RESTRICT never scans children.
--
-- DEFERRED to later migrations (tracked here so nothing is forgotten):
--   RLS step (next migration):
--     - ENABLE + FORCE ROW LEVEL SECURITY and policies on every table below,
--       including each audit_logs partition; roles ae_migrator / ae_app; grants.
--     - current_tenant_id() & friends, then:
--       ALTER TABLE tenant_members ALTER COLUMN tenant_id SET DEFAULT current_tenant_id();
--     - audit_logs: block UPDATE/DELETE for app roles (grants + policies).
--   When the parent tables exist:
--     - tenants.partner_id            -> partners(id) ON DELETE RESTRICT
--     - tenants.geo_area_id           -> geo_areas(id) ON DELETE RESTRICT
--       + trigger: area level upazila/metro_thana and not awaiting manual review
--     - tenant_members.home_locality_id -> localities(tenant_id, id)
--       ON DELETE SET NULL (home_locality_id), + supporting index
--     - blacklist_entries.(source_tenant_id, source_report_id)
--       -> reports(tenant_id, id) ON DELETE SET NULL (source_report_id)
--   Behaviour triggers that need other tables:
--     - tenants status transitions + tenant_status_changes logging
--     - tenant_settings.setting_overrides validation against platform_settings
--     - audit_row_change() triggers on users / tenant_members / tenants / blacklist_entries

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.tenant_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_statuses_pk PRIMARY KEY (code),
  CONSTRAINT tenant_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER tenant_statuses_set_updated_at BEFORE UPDATE ON public.tenant_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.tenant_statuses (code, label_key, sort_order) VALUES
  ('provisioning', 'enum.tenant_statuses.provisioning', 10),
  ('active',       'enum.tenant_statuses.active',       20),
  ('past_due',     'enum.tenant_statuses.past_due',     30),
  ('suspended',    'enum.tenant_statuses.suspended',    40),
  ('terminated',   'enum.tenant_statuses.terminated',   50),
  ('archived',     'enum.tenant_statuses.archived',     60);
--> statement-breakpoint

CREATE TABLE public.user_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_statuses_pk PRIMARY KEY (code),
  CONSTRAINT user_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER user_statuses_set_updated_at BEFORE UPDATE ON public.user_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.user_statuses (code, label_key, sort_order) VALUES
  ('active',      'enum.user_statuses.active',      10),
  ('deactivated', 'enum.user_statuses.deactivated', 20);
--> statement-breakpoint

CREATE TABLE public.platform_roles (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_roles_pk PRIMARY KEY (code),
  CONSTRAINT platform_roles_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER platform_roles_set_updated_at BEFORE UPDATE ON public.platform_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.platform_roles (code, label_key, sort_order) VALUES
  ('platform_admin',   'enum.platform_roles.platform_admin',   10),
  ('platform_support', 'enum.platform_roles.platform_support', 20),
  ('platform_finance', 'enum.platform_roles.platform_finance', 30);
--> statement-breakpoint

CREATE TABLE public.member_roles (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_roles_pk PRIMARY KEY (code),
  CONSTRAINT member_roles_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER member_roles_set_updated_at BEFORE UPDATE ON public.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.member_roles (code, label_key, sort_order) VALUES
  ('member',        'enum.member_roles.member',        10),
  ('agent',         'enum.member_roles.agent',         20),
  ('moderator',     'enum.member_roles.moderator',     30),
  ('tenant_admin',  'enum.member_roles.tenant_admin',  40),
  ('partner_owner', 'enum.member_roles.partner_owner', 50);
--> statement-breakpoint

CREATE TABLE public.member_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_statuses_pk PRIMARY KEY (code),
  CONSTRAINT member_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER member_statuses_set_updated_at BEFORE UPDATE ON public.member_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.member_statuses (code, label_key, sort_order) VALUES
  ('active', 'enum.member_statuses.active', 10),
  ('left',   'enum.member_statuses.left',   20);
--> statement-breakpoint

CREATE TABLE public.moderation_modes (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_modes_pk PRIMARY KEY (code),
  CONSTRAINT moderation_modes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER moderation_modes_set_updated_at BEFORE UPDATE ON public.moderation_modes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.moderation_modes (code, label_key, sort_order) VALUES
  ('post', 'enum.moderation_modes.post', 10),
  ('pre',  'enum.moderation_modes.pre',  20);
--> statement-breakpoint

CREATE TABLE public.ban_severities (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ban_severities_pk PRIMARY KEY (code),
  CONSTRAINT ban_severities_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER ban_severities_set_updated_at BEFORE UPDATE ON public.ban_severities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.ban_severities (code, label_key, sort_order) VALUES
  ('restricted', 'enum.ban_severities.restricted', 10),
  ('banned',     'enum.ban_severities.banned',     20);
--> statement-breakpoint

CREATE TABLE public.blacklist_reasons (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blacklist_reasons_pk PRIMARY KEY (code),
  CONSTRAINT blacklist_reasons_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER blacklist_reasons_set_updated_at BEFORE UPDATE ON public.blacklist_reasons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.blacklist_reasons (code, label_key, sort_order) VALUES
  ('advance_payment_scam', 'enum.blacklist_reasons.advance_payment_scam', 10),
  ('fake_product',         'enum.blacklist_reasons.fake_product',         20),
  ('identity_fraud',       'enum.blacklist_reasons.identity_fraud',       30),
  ('harassment',           'enum.blacklist_reasons.harassment',           40),
  ('payment_fraud',        'enum.blacklist_reasons.payment_fraud',        50);
--> statement-breakpoint

CREATE TABLE public.blacklist_severities (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blacklist_severities_pk PRIMARY KEY (code),
  CONSTRAINT blacklist_severities_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER blacklist_severities_set_updated_at BEFORE UPDATE ON public.blacklist_severities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.blacklist_severities (code, label_key, sort_order) VALUES
  ('watch',      'enum.blacklist_severities.watch',      10),
  ('restricted', 'enum.blacklist_severities.restricted', 20),
  ('banned',     'enum.blacklist_severities.banned',     30),
  ('terminated', 'enum.blacklist_severities.terminated', 40);
--> statement-breakpoint

CREATE TABLE public.blacklist_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blacklist_statuses_pk PRIMARY KEY (code),
  CONSTRAINT blacklist_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER blacklist_statuses_set_updated_at BEFORE UPDATE ON public.blacklist_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.blacklist_statuses (code, label_key, sort_order) VALUES
  ('recommended', 'enum.blacklist_statuses.recommended', 10),
  ('active',      'enum.blacklist_statuses.active',      20),
  ('rejected',    'enum.blacklist_statuses.rejected',    30),
  ('revoked',     'enum.blacklist_statuses.revoked',     40),
  ('expired',     'enum.blacklist_statuses.expired',     50);
--> statement-breakpoint

-- ============================================================================
-- users (§2.7): GLOBAL person account, identified by phone
-- ============================================================================

CREATE TABLE public.users (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  phone_e164            text        NOT NULL,
  phone_verified_at     timestamptz,
  email                 text,
  email_verified_at     timestamptz,
  status_code           text        NOT NULL DEFAULT 'active',
  platform_role_code    text,
  preferred_locale      text        NOT NULL DEFAULT 'bn',
  identity_verified_at  timestamptz,
  last_login_at         timestamptz,
  status_changed_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT users_pk PRIMARY KEY (id),
  CONSTRAINT users_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.user_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT users_platform_role_code_fk FOREIGN KEY (platform_role_code)
    REFERENCES public.platform_roles (code) ON DELETE RESTRICT,
  -- Bangladeshi mobile numbers only (Q24). A closed account's number is
  -- replaced by a tombstone during PII scrub (§13.20), so the format rule
  -- applies to live accounts only.
  CONSTRAINT users_phone_e164_ck
    CHECK (deleted_at IS NOT NULL OR phone_e164 ~ '^\+8801[3-9][0-9]{8}$'),
  CONSTRAINT users_email_ck CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT users_preferred_locale_ck CHECK (preferred_locale IN ('bn', 'en'))
);
--> statement-breakpoint
-- One live account per number; closed accounts release it (SIM recycling, §13.21).
CREATE UNIQUE INDEX users_phone_e164_live_uq ON public.users (phone_e164)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_live_uq ON public.users (email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- Platform staff list.
CREATE INDEX users_platform_role_code_idx ON public.users (platform_role_code)
  WHERE platform_role_code IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenants (§2.3): GLOBAL, one operating territory (upazila / metro thana)
-- ============================================================================

CREATE TABLE public.tenants (
  id              uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  partner_id      uuid        NOT NULL,  -- FK added with partners
  geo_area_id     uuid        NOT NULL,  -- FK added with geo_areas
  slug            text        NOT NULL,
  name_bn         text        NOT NULL,
  name_en         text        NOT NULL,
  status_code     text        NOT NULL DEFAULT 'provisioning',
  default_locale  text        NOT NULL DEFAULT 'bn',
  timezone        text        NOT NULL DEFAULT 'Asia/Dhaka',
  map_center      geography(Point, 4326) NOT NULL,
  launched_at     timestamptz,
  past_due_since  timestamptz,
  suspended_at    timestamptz,
  terminated_at   timestamptz,
  archived_at     timestamptz,
  status_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_pk PRIMARY KEY (id),
  CONSTRAINT tenants_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.tenant_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT tenants_slug_ck CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  CONSTRAINT tenants_name_bn_ck CHECK (btrim(name_bn) <> ''),
  CONSTRAINT tenants_name_en_ck CHECK (btrim(name_en) <> ''),
  CONSTRAINT tenants_default_locale_ck CHECK (default_locale IN ('bn', 'en'))
);
--> statement-breakpoint
-- Subdomain routing.
CREATE UNIQUE INDEX tenants_slug_uq ON public.tenants (slug);
--> statement-breakpoint
-- One live tenant per upazila / metro thana (Q3); archived areas can be re-let.
CREATE UNIQUE INDEX tenants_geo_area_id_live_uq ON public.tenants (geo_area_id)
  WHERE status_code <> 'archived';
--> statement-breakpoint
-- "Tenants operated by partner X"; also the future partners FK index.
CREATE INDEX tenants_partner_id_idx ON public.tenants (partner_id);
--> statement-breakpoint
-- Every geography column has a GiST index (audit rule); nearest tenant.
CREATE INDEX tenants_map_center_gist_idx ON public.tenants USING gist (map_center);
--> statement-breakpoint
-- Daily lifecycle job.
CREATE INDEX tenants_lifecycle_idx ON public.tenants (status_code)
  WHERE status_code IN ('past_due', 'suspended', 'terminated', 'archived');
--> statement-breakpoint
CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenant_settings (§2.4): TENANT-SCOPED, 1:1 with tenants
-- ============================================================================

CREATE TABLE public.tenant_settings (
  tenant_id                  uuid        NOT NULL,
  contact_phone_e164         text,
  contact_email              text,
  whatsapp_e164              text,
  about_bn                   text,
  about_en                   text,
  logo_storage_key           text,
  post_moderation_mode_code  text        NOT NULL DEFAULT 'post',
  setting_overrides          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  feature_flags              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_settings_pk PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_settings_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_settings_post_moderation_mode_code_fk FOREIGN KEY (post_moderation_mode_code)
    REFERENCES public.moderation_modes (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_settings_contact_phone_e164_ck
    CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT tenant_settings_whatsapp_e164_ck
    CHECK (whatsapp_e164 IS NULL OR whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT tenant_settings_contact_email_ck
    CHECK (contact_email IS NULL OR contact_email = lower(contact_email)),
  CONSTRAINT tenant_settings_setting_overrides_ck CHECK (jsonb_typeof(setting_overrides) = 'object'),
  CONSTRAINT tenant_settings_feature_flags_ck CHECK (jsonb_typeof(feature_flags) = 'object')
);
--> statement-breakpoint
CREATE TRIGGER tenant_settings_set_updated_at BEFORE UPDATE ON public.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenant_members (§2.11): TENANT-SCOPED membership (role, status, ban status)
-- ============================================================================

CREATE TABLE public.tenant_members (
  id                 uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,  -- DEFAULT current_tenant_id() comes with the auth step
  user_id            uuid        NOT NULL,
  role_code          text        NOT NULL DEFAULT 'member',
  status_code        text        NOT NULL DEFAULT 'active',
  ban_severity_code  text,
  home_locality_id   uuid,                  -- composite FK added with localities
  joined_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT tenant_members_pk PRIMARY KEY (id),
  CONSTRAINT tenant_members_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  -- A membership (and its wallet) must never vanish with a user.
  CONSTRAINT tenant_members_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_members_role_code_fk FOREIGN KEY (role_code)
    REFERENCES public.member_roles (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_members_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.member_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_members_ban_severity_code_fk FOREIGN KEY (ban_severity_code)
    REFERENCES public.ban_severities (code) ON DELETE RESTRICT,
  -- One membership per user per tenant; resolves app.member_id per request;
  -- target of credit_wallets and bans FKs.
  CONSTRAINT tenant_members_user_id_tenant_id_uq UNIQUE (user_id, tenant_id),
  -- tenant_id-leading index and composite-FK target (§0.4).
  CONSTRAINT tenant_members_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Staff list.
CREATE INDEX tenant_members_staff_idx ON public.tenant_members (tenant_id, role_code)
  WHERE role_code <> 'member';
--> statement-breakpoint
-- Credit port destination: where is this user active (§13.32).
CREATE INDEX tenant_members_user_id_last_active_at_idx ON public.tenant_members (user_id, last_active_at DESC)
  WHERE last_active_at IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER tenant_members_set_updated_at BEFORE UPDATE ON public.tenant_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- blacklist_entries (§9.6): GLOBAL fraud flags (recommend-only for tenants)
-- ============================================================================

CREATE TABLE public.blacklist_entries (
  id                       uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id                  uuid,
  phone_e164               text,
  document_number_hash     text,
  device_fingerprint_hash  text,
  reason_code              text        NOT NULL,
  severity_code            text        NOT NULL,
  status_code              text        NOT NULL DEFAULT 'recommended',
  summary                  text        NOT NULL,
  source_tenant_id         uuid,
  source_report_id         uuid,       -- composite FK added with reports
  recommended_by_user_id   uuid        NOT NULL,
  evidence_refs            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by_user_id      uuid,
  reviewed_at              timestamptz,
  expires_at               timestamptz,
  revoked_at               timestamptz,
  revoke_reason            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blacklist_entries_pk PRIMARY KEY (id),
  CONSTRAINT blacklist_entries_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT blacklist_entries_reason_code_fk FOREIGN KEY (reason_code)
    REFERENCES public.blacklist_reasons (code) ON DELETE RESTRICT,
  CONSTRAINT blacklist_entries_severity_code_fk FOREIGN KEY (severity_code)
    REFERENCES public.blacklist_severities (code) ON DELETE RESTRICT,
  CONSTRAINT blacklist_entries_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.blacklist_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT blacklist_entries_source_tenant_id_fk FOREIGN KEY (source_tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT blacklist_entries_recommended_by_user_id_fk FOREIGN KEY (recommended_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT blacklist_entries_reviewed_by_user_id_fk FOREIGN KEY (reviewed_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT blacklist_entries_identifier_ck
    CHECK (num_nonnulls(user_id, phone_e164, document_number_hash, device_fingerprint_hash) >= 1),
  CONSTRAINT blacklist_entries_phone_e164_ck
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT blacklist_entries_summary_ck CHECK (btrim(summary) <> ''),
  CONSTRAINT blacklist_entries_evidence_refs_ck CHECK (jsonb_typeof(evidence_refs) = 'array'),
  -- An active entry needs evidence (incl. permanent ones, expires_at IS NULL).
  CONSTRAINT blacklist_entries_active_evidence_ck
    CHECK (status_code <> 'active' OR jsonb_array_length(evidence_refs) >= 1),
  -- Only a named platform reviewer can activate or reject.
  CONSTRAINT blacklist_entries_reviewer_ck
    CHECK (status_code NOT IN ('active', 'rejected') OR reviewed_by_user_id IS NOT NULL)
);
--> statement-breakpoint
-- Signup / login / post-time checks against active flags.
CREATE INDEX blacklist_entries_phone_e164_active_idx ON public.blacklist_entries (phone_e164)
  WHERE status_code = 'active';
--> statement-breakpoint
CREATE INDEX blacklist_entries_user_id_active_idx ON public.blacklist_entries (user_id)
  WHERE status_code = 'active';
--> statement-breakpoint
-- KYC-time check.
CREATE INDEX blacklist_entries_document_number_hash_active_idx ON public.blacklist_entries (document_number_hash)
  WHERE status_code = 'active';
--> statement-breakpoint
CREATE INDEX blacklist_entries_device_fingerprint_hash_active_idx ON public.blacklist_entries (device_fingerprint_hash)
  WHERE status_code = 'active';
--> statement-breakpoint
-- Platform review queue.
CREATE INDEX blacklist_entries_review_queue_idx ON public.blacklist_entries (status_code, id)
  WHERE status_code = 'recommended';
--> statement-breakpoint
-- "What has our tenant recommended".
CREATE INDEX blacklist_entries_source_tenant_id_idx ON public.blacklist_entries (source_tenant_id, id DESC);
--> statement-breakpoint
-- FK indexes for RESTRICT / SET NULL checks on users (§0.4).
CREATE INDEX blacklist_entries_user_id_idx ON public.blacklist_entries (user_id)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX blacklist_entries_recommended_by_user_id_idx ON public.blacklist_entries (recommended_by_user_id);
--> statement-breakpoint
CREATE INDEX blacklist_entries_reviewed_by_user_id_idx ON public.blacklist_entries (reviewed_by_user_id)
  WHERE reviewed_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER blacklist_entries_set_updated_at BEFORE UPDATE ON public.blacklist_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- audit_logs (§11.4): immutable, monthly range partitions, retained permanently
-- ============================================================================

CREATE TABLE public.audit_logs (
  id             uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  tenant_id      uuid,       -- nullable: platform-level actions (§0.4); no FK by design
  actor_user_id  uuid,       -- no FK: the log outlives its subjects
  actor_role     text        NOT NULL,
  action         text        NOT NULL,
  entity_table   text        NOT NULL,
  entity_id      uuid,
  changes        jsonb,
  reason         text,
  request_id     text,
  ip_address     inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- A partitioned table's PK must include the partition key.
  CONSTRAINT audit_logs_pk PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_logs_action_ck CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT audit_logs_changes_ck CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object')
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
-- Tenant admin audit view.
CREATE INDEX audit_logs_tenant_id_occurred_at_idx ON public.audit_logs (tenant_id, occurred_at DESC);
--> statement-breakpoint
-- History of one record.
CREATE INDEX audit_logs_entity_idx ON public.audit_logs (entity_table, entity_id, occurred_at DESC);
--> statement-breakpoint
-- What did this staff member do.
CREATE INDEX audit_logs_actor_user_id_occurred_at_idx ON public.audit_logs (actor_user_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX audit_logs_occurred_at_brin_idx ON public.audit_logs USING brin (occurred_at);
--> statement-breakpoint

-- Audit rows are immutable (§11.4): no UPDATE or DELETE, for any role.
-- Named to sort before *_set_updated_at so it fires first.
CREATE OR REPLACE FUNCTION public.audit_logs_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_set_updated_at BEFORE UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ensure_audit_log_partitions(from_month, months): creates any missing monthly
-- partitions audit_logs_yYYYYmMM covering [from_month, from_month + months),
-- with boundaries at Asia/Dhaka midnight. Idempotent. A scheduled job calls it
-- to keep partitions ahead of time. There is deliberately no DEFAULT partition:
-- an insert outside the covered range fails loudly instead of silently piling
-- up rows that would block future partition creation.
CREATE OR REPLACE FUNCTION public.ensure_audit_log_partitions(from_month date, months integer)
RETURNS integer
LANGUAGE plpgsql
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
    partition_name := format('audit_logs_y%sm%s', to_char(month_start, 'YYYY'), to_char(month_start, 'MM'));
    IF to_regclass(format('public.%I', partition_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        (month_start::timestamp AT TIME ZONE 'Asia/Dhaka'),
        ((month_start + interval '1 month')::timestamp AT TIME ZONE 'Asia/Dhaka')
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint
-- Current Dhaka month plus the next three.
SELECT public.ensure_audit_log_partitions((now() AT TIME ZONE 'Asia/Dhaka')::date, 4);

-- 0003_tenancy_partners_settings
--
-- Finishes the Tenancy & identity domain (§2) that 0001 started: partners,
-- their payout accounts, the rest of the user-account tables, tenant
-- lifecycle/billing bookkeeping, and platform_settings (the table
-- apps/api/src/settings already reads from — it did not exist until this
-- migration). Runs as ae_migrator; RLS is enabled and policies attached in
-- the same file, per the same model as 0002 (docs/decisions/019).
--
-- Closes three items from 0001's deferred list, now that their target
-- tables/functions exist:
--   - tenants.partner_id           -> partners(id) ON DELETE RESTRICT
--   - ALTER TABLE tenant_members ALTER COLUMN tenant_id
--       SET DEFAULT current_tenant_id() (existing rows are untouched; this
--       only changes what a future bare INSERT defaults to)
--   - tenant_settings.setting_overrides validated against platform_settings
--     (BEFORE INSERT/UPDATE trigger, added at the end of this file)
--
-- Still deferred (tracked so nothing is forgotten):
--   - tenant_domains: no auth/routing layer to test it against yet.
--   - tenant_transfers.credit_valuation_method_code -> credit_valuation_methods
--     (0007 commerce) and .final_settlement_id -> settlements (0008 payments).
--   - The AFTER UPDATE OF status_code trigger on tenants that validates
--     lifecycle transitions and logs to tenant_status_changes (§13.30's full
--     grace-period state machine is its own design task, not "create the
--     table"). tenant_status_changes exists and is ready to receive rows;
--     nothing writes to it yet.
--   - user_profiles.trust_band_code -> trust_bands (0010 trust).
--   - vat_rates.revenue_stream_code -> revenue_streams (0007 commerce).
--   - auth_refresh_tokens' SECURITY DEFINER auth_rotate_refresh_token() and
--     user_profiles' ban-aware visibility: both need the auth phase / bans
--     (0010), which CLAUDE.md's current phase excludes. Interim: every
--     user_profiles row is publicly readable (see that policy's comment for
--     why a partial, SECURITY-DEFINER-based version would not work anyway).
--
-- Conventions: see 0001's header. New this migration: app_role() and its
-- derived predicates (app_is_platform, app_is_system, app_is_tenant_admin,
-- app_is_staff), needed because several tables here have role-graded RLS
-- beyond the platform_admin/tenant-isolation split 0002 covered.

-- ============================================================================
-- Session helpers, continued from 0002. All STABLE, fail closed to 'anon'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.app_role()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(nullif(current_setting('app.role', true), ''), 'anon')
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.app_role() IS
  'The session role from app.role, defaulting to ''anon'' when unset (never NULL, so callers can use it directly in IN-lists).';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_platform()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT public.app_role() IN ('platform_admin', 'platform_support', 'platform_finance')
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.app_is_platform() IS
  'Any platform staff role. Broader than is_platform_admin(), which is only platform_admin/system (the RLS bypass flag).';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_system()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT public.app_role() = 'system'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_tenant_admin()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT public.app_role() IN ('tenant_admin', 'partner_owner')
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.app_is_tenant_admin() IS
  'Wherever docs/specs/schema.md says "tenant_admin" without naming partner_owner separately, it means this.';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT public.app_role() IN ('moderator', 'tenant_admin', 'partner_owner')
$$;
--> statement-breakpoint

-- ============================================================================
-- Enum tables
-- ============================================================================

CREATE TABLE public.partner_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_statuses_pk PRIMARY KEY (code),
  CONSTRAINT partner_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER partner_statuses_set_updated_at BEFORE UPDATE ON public.partner_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.partner_statuses (code, label_key, sort_order) VALUES
  ('prospect',   'enum.partner_statuses.prospect',   10),
  ('active',     'enum.partner_statuses.active',     20),
  ('suspended',  'enum.partner_statuses.suspended',  30),
  ('terminated', 'enum.partner_statuses.terminated', 40);
--> statement-breakpoint

CREATE TABLE public.payout_methods (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_methods_pk PRIMARY KEY (code),
  CONSTRAINT payout_methods_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER payout_methods_set_updated_at BEFORE UPDATE ON public.payout_methods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.payout_methods (code, label_key, sort_order) VALUES
  ('bank_transfer', 'enum.payout_methods.bank_transfer', 10),
  ('bkash',         'enum.payout_methods.bkash',         20),
  ('nagad',         'enum.payout_methods.nagad',         30);
--> statement-breakpoint

CREATE TABLE public.device_platforms (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_platforms_pk PRIMARY KEY (code),
  CONSTRAINT device_platforms_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER device_platforms_set_updated_at BEFORE UPDATE ON public.device_platforms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.device_platforms (code, label_key, sort_order) VALUES
  ('android', 'enum.device_platforms.android', 10),
  ('ios',     'enum.device_platforms.ios',     20),
  ('web',     'enum.device_platforms.web',     30);
--> statement-breakpoint

CREATE TABLE public.counter_types (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counter_types_pk PRIMARY KEY (code),
  CONSTRAINT counter_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER counter_types_set_updated_at BEFORE UPDATE ON public.counter_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.counter_types (code, label_key, sort_order) VALUES
  ('invoice',        'enum.counter_types.invoice',        10),
  ('support_ticket',  'enum.counter_types.support_ticket', 20),
  ('tax_invoice',     'enum.counter_types.tax_invoice',    30);
--> statement-breakpoint

CREATE TABLE public.consent_types (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_types_pk PRIMARY KEY (code),
  CONSTRAINT consent_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER consent_types_set_updated_at BEFORE UPDATE ON public.consent_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.consent_types (code, label_key, sort_order) VALUES
  ('terms_of_service',   'enum.consent_types.terms_of_service',   10),
  ('privacy_policy',     'enum.consent_types.privacy_policy',     20),
  ('marketing_sms',      'enum.consent_types.marketing_sms',      30),
  ('blood_donor_listing', 'enum.consent_types.blood_donor_listing', 40),
  ('kyc_processing',     'enum.consent_types.kyc_processing',     50),
  ('precise_location',   'enum.consent_types.precise_location',   60);
--> statement-breakpoint

CREATE TABLE public.tenant_transfer_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_transfer_statuses_pk PRIMARY KEY (code),
  CONSTRAINT tenant_transfer_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER tenant_transfer_statuses_set_updated_at BEFORE UPDATE ON public.tenant_transfer_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.tenant_transfer_statuses (code, label_key, sort_order) VALUES
  ('draft',     'enum.tenant_transfer_statuses.draft',     10),
  ('agreed',    'enum.tenant_transfer_statuses.agreed',    20),
  ('effective', 'enum.tenant_transfer_statuses.effective', 30),
  ('cancelled', 'enum.tenant_transfer_statuses.cancelled', 40);
--> statement-breakpoint

CREATE TABLE public.setting_value_types (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT setting_value_types_pk PRIMARY KEY (code),
  CONSTRAINT setting_value_types_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER setting_value_types_set_updated_at BEFORE UPDATE ON public.setting_value_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.setting_value_types (code, label_key, sort_order) VALUES
  ('integer',                'enum.setting_value_types.integer',                10),
  ('decimal',                'enum.setting_value_types.decimal',                20),
  ('money',                  'enum.setting_value_types.money',                  30),
  ('boolean',                'enum.setting_value_types.boolean',                40),
  ('text',                   'enum.setting_value_types.text',                   50),
  ('nullable_integer_array', 'enum.setting_value_types.nullable_integer_array', 60);
--> statement-breakpoint

CREATE TABLE public.setting_override_scopes (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT setting_override_scopes_pk PRIMARY KEY (code),
  CONSTRAINT setting_override_scopes_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER setting_override_scopes_set_updated_at BEFORE UPDATE ON public.setting_override_scopes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.setting_override_scopes (code, label_key, sort_order) VALUES
  ('none',         'enum.setting_override_scopes.none',         10),
  ('platform',      'enum.setting_override_scopes.platform',     20),
  ('tenant_admin',  'enum.setting_override_scopes.tenant_admin', 30);
--> statement-breakpoint

-- ============================================================================
-- partners (§2.1): GLOBAL, the legal entity operating one or more tenants
-- ============================================================================

CREATE TABLE public.partners (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  legal_name          text        NOT NULL,
  display_name        text        NOT NULL,
  contact_user_id     uuid,
  phone_e164          text        NOT NULL,
  email               text,
  trade_license_no    text,
  tin                 text,
  address             text,
  status_code         text        NOT NULL DEFAULT 'prospect',
  contract_signed_on  date,
  contract_ends_on    date,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT partners_pk PRIMARY KEY (id),
  CONSTRAINT partners_contact_user_id_fk FOREIGN KEY (contact_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT partners_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.partner_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT partners_phone_e164_ck CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT partners_email_ck CHECK (email IS NULL OR email = lower(email))
);
--> statement-breakpoint
-- Don't onboard the same business twice.
CREATE UNIQUE INDEX partners_trade_license_no_uq ON public.partners (trade_license_no)
  WHERE trade_license_no IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX partners_contact_user_id_idx ON public.partners (contact_user_id)
  WHERE contact_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER partners_set_updated_at BEFORE UPDATE ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- partner_payout_accounts (§2.2): GLOBAL, where a partner receives payouts
-- ============================================================================

CREATE TABLE public.partner_payout_accounts (
  id                          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  partner_id                  uuid        NOT NULL,
  method_code                 text        NOT NULL,
  account_name                text        NOT NULL,
  account_number_ciphertext   text        NOT NULL,
  account_number_last4        text        NOT NULL,
  bank_name                   text,
  branch_name                 text,
  routing_number               text,
  is_default                  boolean     NOT NULL DEFAULT false,
  verified_at                 timestamptz,
  verified_by_user_id         uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  CONSTRAINT partner_payout_accounts_pk PRIMARY KEY (id),
  CONSTRAINT partner_payout_accounts_partner_id_fk FOREIGN KEY (partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT partner_payout_accounts_method_code_fk FOREIGN KEY (method_code)
    REFERENCES public.payout_methods (code) ON DELETE RESTRICT,
  CONSTRAINT partner_payout_accounts_verified_by_user_id_fk FOREIGN KEY (verified_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT partner_payout_accounts_bank_name_ck
    CHECK (method_code <> 'bank_transfer' OR bank_name IS NOT NULL)
);
--> statement-breakpoint
-- One default account per partner.
CREATE UNIQUE INDEX partner_payout_accounts_default_uq ON public.partner_payout_accounts (partner_id)
  WHERE is_default AND deleted_at IS NULL;
--> statement-breakpoint
-- FK index (§0.4): also "this partner's accounts".
CREATE INDEX partner_payout_accounts_partner_id_idx ON public.partner_payout_accounts (partner_id);
--> statement-breakpoint
CREATE INDEX partner_payout_accounts_verified_by_user_id_idx ON public.partner_payout_accounts (verified_by_user_id)
  WHERE verified_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER partner_payout_accounts_set_updated_at BEFORE UPDATE ON public.partner_payout_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- user_profiles (§2.8): GLOBAL, 1:1 with users, the public-readable half
-- ============================================================================

CREATE TABLE public.user_profiles (
  user_id               uuid        NOT NULL,
  display_name          text        NOT NULL,
  avatar_storage_key    text,
  bio                   text,
  trust_band_code       text        NOT NULL DEFAULT 'new',  -- FK added with trust_bands (0010)
  is_identity_verified  boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_pk PRIMARY KEY (user_id),
  CONSTRAINT user_profiles_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER user_profiles_set_updated_at BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- The badge/band columns are system-written; an owner UPDATE (display_name,
-- avatar_storage_key, bio) must not smuggle a change to them in.
CREATE OR REPLACE FUNCTION public.user_profiles_protect_system_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (public.app_is_system() OR public.app_is_platform()) THEN
    NEW.trust_band_code := OLD.trust_band_code;
    NEW.is_identity_verified := OLD.is_identity_verified;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- Named to sort before *_set_updated_at so it applies first.
CREATE TRIGGER user_profiles_a_protect_system_columns BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.user_profiles_protect_system_columns();
--> statement-breakpoint

-- ============================================================================
-- user_devices (§2.9): GLOBAL, push tokens and fingerprints
-- ============================================================================

CREATE TABLE public.user_devices (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id           uuid        NOT NULL,
  platform_code     text        NOT NULL,
  push_token        text,
  app_version       text,
  device_model      text,
  fingerprint_hash  text,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_pk PRIMARY KEY (id),
  CONSTRAINT user_devices_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT user_devices_platform_code_fk FOREIGN KEY (platform_code)
    REFERENCES public.device_platforms (code) ON DELETE RESTRICT
);
--> statement-breakpoint
-- A token that shows up under a new login moves to the new user.
CREATE UNIQUE INDEX user_devices_push_token_uq ON public.user_devices (push_token)
  WHERE push_token IS NOT NULL;
--> statement-breakpoint
-- Fan-out push to a user's devices; also the FK index (§0.4).
CREATE INDEX user_devices_user_id_active_idx ON public.user_devices (user_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX user_devices_fingerprint_hash_idx ON public.user_devices (fingerprint_hash)
  WHERE fingerprint_hash IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER user_devices_set_updated_at BEFORE UPDATE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- auth_refresh_tokens (§2.10): GLOBAL, hashed + rotation-family tracked
-- ============================================================================

CREATE TABLE public.auth_refresh_tokens (
  id               uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id          uuid        NOT NULL,
  device_id        uuid,
  token_hash       text        NOT NULL,
  family_id        uuid        NOT NULL,
  replaced_by_id   uuid,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  created_ip       inet,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_refresh_tokens_pk PRIMARY KEY (id),
  CONSTRAINT auth_refresh_tokens_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT auth_refresh_tokens_device_id_fk FOREIGN KEY (device_id)
    REFERENCES public.user_devices (id) ON DELETE SET NULL,
  CONSTRAINT auth_refresh_tokens_replaced_by_id_fk FOREIGN KEY (replaced_by_id)
    REFERENCES public.auth_refresh_tokens (id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX auth_refresh_tokens_token_hash_uq ON public.auth_refresh_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX auth_refresh_tokens_family_id_idx ON public.auth_refresh_tokens (family_id);
--> statement-breakpoint
CREATE INDEX auth_refresh_tokens_user_id_active_idx ON public.auth_refresh_tokens (user_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX auth_refresh_tokens_expires_at_idx ON public.auth_refresh_tokens (expires_at);
--> statement-breakpoint
-- FK index (§0.4).
CREATE INDEX auth_refresh_tokens_device_id_idx ON public.auth_refresh_tokens (device_id)
  WHERE device_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER auth_refresh_tokens_set_updated_at BEFORE UPDATE ON public.auth_refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- user_consents (§2.12): GLOBAL, append-only consent evidence
-- ============================================================================

CREATE TABLE public.user_consents (
  id                   uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  user_id              uuid        NOT NULL,
  consent_type_code    text        NOT NULL,
  document_version     text,
  granted              boolean     NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  collected_by_user_id uuid,
  ip_address           inet,
  user_agent           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_consents_pk PRIMARY KEY (id),
  -- Consent evidence must outlive an account scrub.
  CONSTRAINT user_consents_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT user_consents_collected_by_user_id_fk FOREIGN KEY (collected_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT user_consents_type_code_fk FOREIGN KEY (consent_type_code)
    REFERENCES public.consent_types (code) ON DELETE RESTRICT
);
--> statement-breakpoint
-- Current consent = latest row per type; also the FK index (§0.4).
CREATE INDEX user_consents_user_id_type_recorded_at_idx
  ON public.user_consents (user_id, consent_type_code, recorded_at DESC);
--> statement-breakpoint
-- "Who still has to accept the new terms".
CREATE INDEX user_consents_type_code_document_version_idx
  ON public.user_consents (consent_type_code, document_version);
--> statement-breakpoint
CREATE INDEX user_consents_collected_by_user_id_idx ON public.user_consents (collected_by_user_id)
  WHERE collected_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER user_consents_set_updated_at BEFORE UPDATE ON public.user_consents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- Append-only evidence: no UPDATE or DELETE, for any role.
CREATE OR REPLACE FUNCTION public.user_consents_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'user_consents rows are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER user_consents_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.user_consents
  FOR EACH ROW EXECUTE FUNCTION public.user_consents_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- tenant_domains (§2.5): TENANT-SCOPED, publicly readable (pre-context routing)
-- ============================================================================

CREATE TABLE public.tenant_domains (
  id           uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id    uuid        NOT NULL DEFAULT public.current_tenant_id(),
  hostname     text        NOT NULL,
  is_primary   boolean     NOT NULL DEFAULT false,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_domains_pk PRIMARY KEY (id),
  -- Never cascade from a tenant (§13.30).
  CONSTRAINT tenant_domains_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_domains_hostname_ck CHECK (hostname = lower(hostname)),
  -- Composite-FK target for future tenant-scoped children (§0.4).
  CONSTRAINT tenant_domains_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Request routing: one host -> one tenant.
CREATE UNIQUE INDEX tenant_domains_hostname_uq ON public.tenant_domains (hostname);
--> statement-breakpoint
-- One canonical host per tenant.
CREATE UNIQUE INDEX tenant_domains_primary_uq ON public.tenant_domains (tenant_id)
  WHERE is_primary;
--> statement-breakpoint
CREATE TRIGGER tenant_domains_set_updated_at BEFORE UPDATE ON public.tenant_domains
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenant_counters (§2.6): TENANT-SCOPED, gapless per-tenant sequences
-- ============================================================================

CREATE TABLE public.tenant_counters (
  tenant_id    uuid        NOT NULL DEFAULT public.current_tenant_id(),
  counter_code text        NOT NULL,
  period_key   text        NOT NULL DEFAULT '',
  last_value   bigint      NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_counters_pk PRIMARY KEY (tenant_id, counter_code, period_key),
  CONSTRAINT tenant_counters_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_counters_counter_code_fk FOREIGN KEY (counter_code)
    REFERENCES public.counter_types (code) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER tenant_counters_set_updated_at BEFORE UPDATE ON public.tenant_counters
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenant_status_changes (§2.14): TENANT-SCOPED, append-only lifecycle log.
-- Nothing writes here yet — the trigger on tenants is deferred (see header).
-- ============================================================================

CREATE TABLE public.tenant_status_changes (
  id                  uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT public.current_tenant_id(),
  from_status_code    text,
  to_status_code      text        NOT NULL,
  reason              text        NOT NULL,
  changed_by_user_id  uuid,
  is_automatic        boolean     NOT NULL,
  bypassed_grace      boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_status_changes_pk PRIMARY KEY (id),
  CONSTRAINT tenant_status_changes_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_status_changes_from_status_code_fk FOREIGN KEY (from_status_code)
    REFERENCES public.tenant_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_status_changes_to_status_code_fk FOREIGN KEY (to_status_code)
    REFERENCES public.tenant_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_status_changes_changed_by_user_id_fk FOREIGN KEY (changed_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_status_changes_transition_ck CHECK (from_status_code IS DISTINCT FROM to_status_code),
  CONSTRAINT tenant_status_changes_reason_ck CHECK (btrim(reason) <> ''),
  CONSTRAINT tenant_status_changes_is_automatic_ck CHECK (is_automatic = (changed_by_user_id IS NULL)),
  CONSTRAINT tenant_status_changes_bypassed_grace_ck
    CHECK (NOT bypassed_grace OR (NOT is_automatic AND to_status_code = 'suspended')),
  CONSTRAINT tenant_status_changes_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- Tenant history.
CREATE INDEX tenant_status_changes_tenant_id_id_idx ON public.tenant_status_changes (tenant_id, id DESC);
--> statement-breakpoint
-- Platform reporting.
CREATE INDEX tenant_status_changes_to_status_created_at_idx
  ON public.tenant_status_changes (to_status_code, created_at);
--> statement-breakpoint
CREATE INDEX tenant_status_changes_changed_by_user_id_idx ON public.tenant_status_changes (changed_by_user_id)
  WHERE changed_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER tenant_status_changes_set_updated_at BEFORE UPDATE ON public.tenant_status_changes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.tenant_status_changes_prevent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tenant_status_changes rows are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_status_changes_a_prevent_mutation BEFORE UPDATE OR DELETE ON public.tenant_status_changes
  FOR EACH ROW EXECUTE FUNCTION public.tenant_status_changes_prevent_mutation();
--> statement-breakpoint

-- ============================================================================
-- tenant_billing (§2.15): TENANT-SCOPED, 1:1 with tenants
-- ============================================================================

CREATE TABLE public.tenant_billing (
  tenant_id               uuid           NOT NULL,
  billing_contact_user_id uuid,
  billing_email           text,
  amount_due              numeric(12,2)  NOT NULL DEFAULT 0,
  next_due_at             timestamptz,
  oldest_unpaid_due_at    timestamptz,
  last_payment_at         timestamptz,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  updated_at              timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT tenant_billing_pk PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_billing_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_billing_billing_contact_user_id_fk FOREIGN KEY (billing_contact_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT tenant_billing_amount_due_ck CHECK (amount_due >= 0),
  CONSTRAINT tenant_billing_billing_email_ck CHECK (billing_email IS NULL OR billing_email = lower(billing_email))
);
--> statement-breakpoint
CREATE INDEX tenant_billing_oldest_unpaid_due_at_idx ON public.tenant_billing (oldest_unpaid_due_at)
  WHERE oldest_unpaid_due_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX tenant_billing_next_due_at_idx ON public.tenant_billing (next_due_at)
  WHERE next_due_at IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER tenant_billing_set_updated_at BEFORE UPDATE ON public.tenant_billing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- platform_settings (§2.16): GLOBAL, every number that governs behaviour
-- (CLAUDE.md hard rule 9). Seeded in this migration, per key.
-- ============================================================================

-- Shared by platform_settings' own CHECK and tenant_settings' override
-- validation trigger (below), so the type rules exist in exactly one place.
CREATE OR REPLACE FUNCTION public.setting_value_matches_type(value jsonb, value_type_code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE value_type_code
    WHEN 'integer' THEN
      jsonb_typeof(value) = 'number'
      AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
    WHEN 'decimal' THEN
      jsonb_typeof(value) = 'number'
    WHEN 'money' THEN
      jsonb_typeof(value) = 'string' AND (value #>> '{}') ~ '^[0-9]+\.[0-9]{2}$'
    WHEN 'boolean' THEN
      jsonb_typeof(value) = 'boolean'
    WHEN 'text' THEN
      jsonb_typeof(value) = 'string'
    WHEN 'nullable_integer_array' THEN
      jsonb_typeof(value) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value) elem
        WHERE jsonb_typeof(elem) NOT IN ('number', 'null')
           OR (jsonb_typeof(elem) = 'number' AND (elem #>> '{}')::numeric <> trunc((elem #>> '{}')::numeric))
      )
    ELSE false
  END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.setting_value_matches_type(jsonb, text) IS
  'True when value''s JSON shape matches value_type_code (§2.16). Used by platform_settings''s own CHECK and by tenant_settings_validate_overrides().';
--> statement-breakpoint

CREATE TABLE public.platform_settings (
  key                        text        NOT NULL,
  value                      jsonb       NOT NULL,
  value_type_code            text        NOT NULL,
  unit                       text,
  min_value                  numeric,
  max_value                  numeric,
  tenant_override_scope_code text        NOT NULL DEFAULT 'none',
  description                text        NOT NULL,
  updated_by_user_id         uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_settings_pk PRIMARY KEY (key),
  CONSTRAINT platform_settings_value_type_code_fk FOREIGN KEY (value_type_code)
    REFERENCES public.setting_value_types (code) ON DELETE RESTRICT,
  CONSTRAINT platform_settings_override_scope_code_fk FOREIGN KEY (tenant_override_scope_code)
    REFERENCES public.setting_override_scopes (code) ON DELETE RESTRICT,
  CONSTRAINT platform_settings_updated_by_user_id_fk FOREIGN KEY (updated_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT platform_settings_key_ck CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT platform_settings_value_type_ck CHECK (public.setting_value_matches_type(value, value_type_code)),
  CONSTRAINT platform_settings_bounds_ck CHECK (
    value_type_code NOT IN ('integer', 'decimal', 'money')
    OR (
      (min_value IS NULL OR (value #>> '{}')::numeric >= min_value)
      AND (max_value IS NULL OR (value #>> '{}')::numeric <= max_value)
    )
  ),
  CONSTRAINT platform_settings_description_ck CHECK (btrim(description) <> '')
);
--> statement-breakpoint
CREATE INDEX platform_settings_updated_by_user_id_idx ON public.platform_settings (updated_by_user_id)
  WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Seed: defaults live here, never in application code (CLAUDE.md rule 9).
-- Types/keys mirror apps/api/src/settings/settings.registry.ts exactly;
-- a drift test should assert this (tracked as a follow-up, like Q2's
-- enum/shared-types drift test).
INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('grace_past_due_days', '15', 'integer', 'days', 0, NULL, 'platform',
   'Days a tenant stays past_due before moving to suspended.'),
  ('grace_suspended_days', '30', 'integer', 'days', 0, NULL, 'platform',
   'Days a tenant stays suspended before moving to terminated.'),
  ('grace_terminated_days', '30', 'integer', 'days', 0, NULL, 'platform',
   'Days a tenant stays terminated before archived.'),
  ('archive_after_days', '90', 'integer', 'days', 0, NULL, 'platform',
   'Days after termination before the tenant is archived, if not already.'),
  ('purge_after_days', '365', 'integer', 'days', 0, NULL, 'platform',
   'Days after archival before scheduled data purge.'),
  ('credit_refund_window_days', '90', 'integer', 'days', 0, NULL, 'platform',
   'Window in which a purchased credit is refund-eligible.'),
  ('notice_before_invoice_days', '7', 'integer', 'days', 0, NULL, 'platform',
   'Advance notice before an invoice is due.'),
  ('notice_before_suspend_days', '7', 'integer', 'days', 0, NULL, 'platform',
   'Advance notice before past_due -> suspended.'),
  ('notice_before_terminate_days', '14', 'integer', 'days', 0, NULL, 'platform',
   'Advance notice before suspended -> terminated.'),
  ('media_purge_days', '30', 'integer', 'days', 0, NULL, 'none',
   'Days after an ordinary media/post deletion before the purge job removes the object.'),
  ('scrub_media_purge_days', '0', 'integer', 'days', 0, NULL, 'none',
   'Days after a privacy scrub before media is purged (0 = immediately).'),
  ('orphan_media_hours', '24', 'integer', 'hours', 0, NULL, 'none',
   'Hours an upload can stay pending_upload before the cleanup job deletes it.'),
  ('appeal_escalation_days', '7', 'integer', 'days', 0, NULL, 'platform',
   'Days before a tenant-level ban appeal auto-escalates to platform admin.'),
  ('appeal_rate_limit_per_day', '1', 'integer', 'count', 0, NULL, 'none',
   'Max appeal submissions per phone number per day.'),
  ('ban_ladder_days', '[7, 30, null]', 'nullable_integer_array', 'days', NULL, NULL, 'platform',
   'Escalating temporary-ban durations; null = permanent.'),
  ('saved_search_max_active', '5', 'integer', 'count', 0, NULL, 'none',
   'Max active saved searches per user.'),
  ('saved_search_notify_per_day', '1', 'integer', 'count', 0, NULL, 'none',
   'Max saved-search notifications sent per user per day.'),
  ('saved_search_auto_pause_days', '30', 'integer', 'days', 0, NULL, 'none',
   'Days of no matches before a saved search auto-pauses.'),
  ('boost_slots_per_category', '3', 'integer', 'count', 0, NULL, 'tenant_admin',
   'Concurrent boosted-slot capacity per category.'),
  ('boost_voucher_validity_days', '30', 'integer', 'days', 0, NULL, 'platform',
   'Days a boost voucher stays redeemable.'),
  ('credit_bonus_expiry_days', '7', 'integer', 'days', 0, NULL, 'platform',
   'Days before an unspent bonus credit lot expires.'),
  ('credit_port_max_km', '60', 'decimal', 'km', 0, NULL, 'none',
   'Max distance used when choosing a destination tenant for ported credits.'),
  ('credit_port_activity_lookback_days', '180', 'integer', 'days', 0, NULL, 'none',
   'Lookback window for "where is this user active" when porting credits.'),
  ('post_expiry_days_default', '30', 'integer', 'days', 0, NULL, 'tenant_admin',
   'Default time-to-live for a live post.'),
  ('reconciliation_alert_threshold', '0', 'decimal', 'count', 0, NULL, 'none',
   'Wallet/ledger mismatch count that triggers a reconciliation alert.'),
  ('continuity_subsidy_max_bdt_per_month', '"5000.00"', 'money', 'bdt', 0, NULL, 'platform',
   'Max monthly continuity subsidy paid to a partner for a single tenant.'),
  ('continuity_subsidy_platform_max_bdt_per_month', '"50000.00"', 'money', 'bdt', 0, NULL, 'none',
   'Platform-wide cap on total continuity subsidy paid out per month.'),
  ('credit_refund_sla_days', '10', 'integer', 'days', 0, NULL, 'none',
   'Target turnaround for a credit refund request.'),
  ('refund_manual_verification_threshold_bdt', '"2000.00"', 'money', 'bdt', 0, NULL, 'none',
   'Refund amount above which manual verification is required.'),
  ('free_posts_per_month', '3', 'integer', 'count', 0, NULL, 'tenant_admin',
   'Free (no-credit-cost) posts a member gets per calendar month.'),
  ('boundary_buffer_km', '5', 'decimal', 'km', 0, NULL, 'platform',
   'Buffer distance beyond a tenant boundary still owned by the nearest tenant.'),
  ('lead_dedupe_minutes', '10', 'integer', 'minutes', 0, NULL, 'none',
   'Window for collapsing repeat lead events from the same viewer.'),
  ('outbox_processed_retention_days', '7', 'integer', 'days', 0, NULL, 'none',
   'Days a processed outbox event is kept before cleanup.'),
  ('activity_log_retention_days', '90', 'integer', 'days', 0, NULL, 'none',
   'Days an activity_logs row is kept before cleanup.'),
  ('lead_event_retention_months', '13', 'integer', 'months', 0, NULL, 'none',
   'Months a lead_events partition is kept before cleanup.'),
  ('export_link_validity_days', '7', 'integer', 'days', 0, NULL, 'none',
   'Days a data-export download link stays valid.'),
  ('appeal_max_attachments', '3', 'integer', 'count', 0, NULL, 'none',
   'Max evidence attachments on one ban appeal.'),
  ('tenant_refund_approval_limit_bdt', '"1000.00"', 'money', 'bdt', 0, NULL, 'platform',
   'Refund amount a tenant admin may approve without platform sign-off.'),
  ('message_body_retention_days', '180', 'integer', 'days', 0, NULL, 'none',
   'Days a chat message body is retained before redaction.'),
  ('kyc_document_retention_days', '90', 'integer', 'days', 0, NULL, 'none',
   'Days a KYC/verification document is retained after its decision.'),
  ('blood_donation_interval_days', '120', 'integer', 'days', 0, NULL, 'none',
   'Minimum days between a donor''s listed donations.'),
  ('auto_hide_report_threshold', '3', 'integer', 'count', 0, NULL, 'tenant_admin',
   'Distinct reports on a live post before it is auto-hidden pending review.'),
  ('ban_escalation_lookback_days', '365', 'integer', 'days', 0, NULL, 'platform',
   'Window of prior bans considered when escalating the ban ladder.'),
  ('landmark_default_radius_km', '10', 'decimal', 'km', 0, NULL, 'platform',
   'Default radius within which a landmark place is visible to neighbouring tenants.'),
  ('agent_cash_max_hold_hours', '48', 'integer', 'hours', 0, NULL, 'tenant_admin',
   'Max hours a field agent may hold collected cash before remittance is due.');
--> statement-breakpoint

-- ============================================================================
-- platform_counters (§2.17): GLOBAL, gapless platform-level sequences
-- ============================================================================

CREATE TABLE public.platform_counters (
  counter_code text        NOT NULL,
  period_key   text        NOT NULL,
  last_value   bigint      NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_counters_pk PRIMARY KEY (counter_code, period_key),
  CONSTRAINT platform_counters_counter_code_fk FOREIGN KEY (counter_code)
    REFERENCES public.counter_types (code) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER platform_counters_set_updated_at BEFORE UPDATE ON public.platform_counters
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- vat_rates (§2.18): GLOBAL, dated VAT rates per revenue stream
-- ============================================================================

CREATE TABLE public.vat_rates (
  id                    uuid           NOT NULL DEFAULT public.uuid_generate_v7(),
  revenue_stream_code   text           NOT NULL,  -- FK added with revenue_streams (0007)
  rate                  numeric(5,4)   NOT NULL,
  effective_from        date           NOT NULL,
  effective_to          date,
  legal_reference       text,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT vat_rates_pk PRIMARY KEY (id),
  CONSTRAINT vat_rates_rate_ck CHECK (rate BETWEEN 0 AND 1),
  -- One rate per stream per day.
  CONSTRAINT vat_rates_stream_period_excl EXCLUDE USING gist (
    revenue_stream_code WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
--> statement-breakpoint
CREATE TRIGGER vat_rates_set_updated_at BEFORE UPDATE ON public.vat_rates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- tenant_transfers (§2.13): TENANT-SCOPED, partner handover incl. credit
-- liability. credit_valuation_method_code and final_settlement_id keep the
-- FKs their target tables (0007, 0008) will add.
-- ============================================================================

CREATE TABLE public.tenant_transfers (
  id                            uuid           NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id                     uuid           NOT NULL DEFAULT public.current_tenant_id(),
  from_partner_id               uuid           NOT NULL,
  to_partner_id                 uuid           NOT NULL,
  status_code                   text           NOT NULL DEFAULT 'draft',
  effective_at                  timestamptz,
  outstanding_credits           bigint         NOT NULL DEFAULT 0,
  credit_valuation_method_code  text           NOT NULL DEFAULT 'original_purchase_price',
  credit_liability_amount       numeric(12,2)  NOT NULL DEFAULT 0,
  valuation_detail              jsonb          NOT NULL DEFAULT '{}'::jsonb,
  final_settlement_id           uuid,
  liability_journal_id          uuid,
  agreement_storage_keys        text[]         NOT NULL DEFAULT '{}',
  approved_by_user_id           uuid,
  cancelled_reason              text,
  notes                         text,
  created_at                    timestamptz    NOT NULL DEFAULT now(),
  updated_at                    timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT tenant_transfers_pk PRIMARY KEY (id),
  CONSTRAINT tenant_transfers_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_transfers_from_partner_id_fk FOREIGN KEY (from_partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_transfers_to_partner_id_fk FOREIGN KEY (to_partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_transfers_status_code_fk FOREIGN KEY (status_code)
    REFERENCES public.tenant_transfer_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT tenant_transfers_approved_by_user_id_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT,
  CONSTRAINT tenant_transfers_partners_distinct_ck CHECK (to_partner_id <> from_partner_id),
  CONSTRAINT tenant_transfers_effective_at_ck
    CHECK (status_code IN ('draft', 'cancelled') OR effective_at IS NOT NULL),
  CONSTRAINT tenant_transfers_approved_by_ck
    CHECK (status_code NOT IN ('agreed', 'effective') OR approved_by_user_id IS NOT NULL),
  CONSTRAINT tenant_transfers_outstanding_credits_ck CHECK (outstanding_credits >= 0),
  CONSTRAINT tenant_transfers_credit_liability_amount_ck CHECK (credit_liability_amount >= 0),
  CONSTRAINT tenant_transfers_valuation_detail_ck CHECK (jsonb_typeof(valuation_detail) = 'object'),
  CONSTRAINT tenant_transfers_tenant_id_id_uq UNIQUE (tenant_id, id)
);
--> statement-breakpoint
-- One open transfer per tenant; also the tenant_id index.
CREATE UNIQUE INDEX tenant_transfers_open_uq ON public.tenant_transfers (tenant_id)
  WHERE status_code IN ('draft', 'agreed');
--> statement-breakpoint
-- Partner history of a tenant.
CREATE INDEX tenant_transfers_tenant_id_effective_at_idx
  ON public.tenant_transfers (tenant_id, effective_at DESC);
--> statement-breakpoint
-- Cross-tenant system cutover job.
CREATE INDEX tenant_transfers_agreed_idx ON public.tenant_transfers (status_code, effective_at)
  WHERE status_code = 'agreed';
--> statement-breakpoint
-- FK indexes (§0.4).
CREATE INDEX tenant_transfers_from_partner_id_idx ON public.tenant_transfers (from_partner_id);
--> statement-breakpoint
CREATE INDEX tenant_transfers_to_partner_id_idx ON public.tenant_transfers (to_partner_id);
--> statement-breakpoint
CREATE INDEX tenant_transfers_approved_by_user_id_idx ON public.tenant_transfers (approved_by_user_id)
  WHERE approved_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER tenant_transfers_set_updated_at BEFORE UPDATE ON public.tenant_transfers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- Closing two deferred items from 0001, now that their targets exist.
-- ============================================================================

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_partner_id_fk FOREIGN KEY (partner_id)
    REFERENCES public.partners (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.tenant_members
  ALTER COLUMN tenant_id SET DEFAULT public.current_tenant_id();
--> statement-breakpoint

-- tenant_settings.setting_overrides validated against platform_settings.
CREATE OR REPLACE FUNCTION public.tenant_settings_validate_overrides()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  override_key text;
  setting record;
  numeric_value numeric;
BEGIN
  FOR override_key IN SELECT jsonb_object_keys(NEW.setting_overrides) LOOP
    SELECT * INTO setting FROM public.platform_settings ps WHERE ps.key = override_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tenant_settings.setting_overrides: unknown key "%"', override_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF setting.tenant_override_scope_code = 'none' THEN
      RAISE EXCEPTION 'tenant_settings.setting_overrides: "%" cannot be overridden per tenant', override_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF setting.tenant_override_scope_code = 'platform' AND NOT public.app_is_platform() THEN
      RAISE EXCEPTION 'tenant_settings.setting_overrides: "%" may only be changed by platform staff', override_key
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT public.setting_value_matches_type(NEW.setting_overrides -> override_key, setting.value_type_code) THEN
      RAISE EXCEPTION 'tenant_settings.setting_overrides: "%" does not match its type (%)',
        override_key, setting.value_type_code
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF setting.value_type_code IN ('integer', 'decimal', 'money') THEN
      numeric_value := (NEW.setting_overrides ->> override_key)::numeric;
      IF (setting.min_value IS NOT NULL AND numeric_value < setting.min_value)
         OR (setting.max_value IS NOT NULL AND numeric_value > setting.max_value) THEN
        RAISE EXCEPTION 'tenant_settings.setting_overrides: "%" is out of bounds', override_key
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_settings_b_validate_overrides BEFORE INSERT OR UPDATE OF setting_overrides
  ON public.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION public.tenant_settings_validate_overrides();
--> statement-breakpoint

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
        'partner_statuses', 'payout_methods', 'device_platforms', 'counter_types',
        'consent_types', 'tenant_transfer_statuses', 'setting_value_types', 'setting_override_scopes',
        'partners', 'partner_payout_accounts', 'user_profiles', 'user_devices',
        'auth_refresh_tokens', 'user_consents', 'tenant_domains', 'tenant_counters',
        'tenant_status_changes', 'tenant_billing', 'platform_settings', 'platform_counters',
        'vat_rates', 'tenant_transfers'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.ident);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.ident);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- enum tables: read by all, write by platform admin (as 0002) ----------

DO $$
DECLARE
  enum_table text;
BEGIN
  FOREACH enum_table IN ARRAY ARRAY[
    'partner_statuses', 'payout_methods', 'device_platforms', 'counter_types',
    'consent_types', 'tenant_transfer_statuses', 'setting_value_types', 'setting_override_scopes'
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

-- ---- partners: tenant_admin reads the partner operating their tenant ------

CREATE POLICY partners_tenant_admin_read ON public.partners
  FOR SELECT
  USING (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.tenants t
      WHERE t.partner_id = partners.id AND t.id = (SELECT public.current_tenant_id())
    )
  );
--> statement-breakpoint
CREATE POLICY partners_platform_admin ON public.partners
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- partner_payout_accounts: same visibility, plus system for payout runs

CREATE POLICY partner_payout_accounts_tenant_admin_read ON public.partner_payout_accounts
  FOR SELECT
  USING (
    (SELECT public.app_is_tenant_admin())
    AND EXISTS (
      SELECT 1 FROM public.tenants t
      WHERE t.partner_id = partner_payout_accounts.partner_id
        AND t.id = (SELECT public.current_tenant_id())
    )
  );
--> statement-breakpoint
CREATE POLICY partner_payout_accounts_system_read ON public.partner_payout_accounts
  FOR SELECT
  USING ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY partner_payout_accounts_platform_admin ON public.partner_payout_accounts
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- user_profiles: public; owner writes 3 cols; ban-aware hiding deferred

-- Every profile is publicly readable for now. Hiding a soft-deleted/banned/
-- terminated user's profile is deferred to the auth phase (see header): a
-- SECURITY DEFINER check against `users` does NOT work here, because
-- `users` has FORCE ROW LEVEL SECURITY, which binds a SECURITY DEFINER
-- function's queries to its OWNER too (current_user is the owner during
-- SECURITY DEFINER execution) — there is no ownership-based bypass, by
-- design (docs/decisions/019). The real fix is a denormalised, trigger-
-- maintained visibility flag on this table, sized for when bans (0010)
-- define what "hidden" actually means; a half-built version of it now would
-- be worse than an honest `true`.
CREATE POLICY user_profiles_public_read ON public.user_profiles
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY user_profiles_owner_write ON public.user_profiles
  FOR UPDATE
  USING (user_id = (SELECT public.current_user_id()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY user_profiles_platform_admin ON public.user_profiles
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- user_devices: G-OWNER --------------------------------------------

CREATE POLICY user_devices_owner ON public.user_devices
  FOR ALL
  USING (user_id = (SELECT public.current_user_id()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY user_devices_platform_admin ON public.user_devices
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- auth_refresh_tokens: owner SELECT/UPDATE only (no owner INSERT) -----

CREATE POLICY auth_refresh_tokens_owner_read ON public.auth_refresh_tokens
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY auth_refresh_tokens_owner_revoke ON public.auth_refresh_tokens
  FOR UPDATE
  USING (user_id = (SELECT public.current_user_id()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY auth_refresh_tokens_platform_admin ON public.auth_refresh_tokens
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- user_consents: G-OWNER for SELECT + INSERT, append-only -------------

CREATE POLICY user_consents_owner_read ON public.user_consents
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY user_consents_owner_insert ON public.user_consents
  FOR INSERT
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
CREATE POLICY user_consents_platform_read ON public.user_consents
  FOR SELECT
  USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
-- No UPDATE/DELETE policy for any role beyond this: is_platform_admin() would
-- otherwise bypass the immutability trigger's *intent* (the trigger still
-- blocks it either way, this just keeps the grant surface honest).
CREATE POLICY user_consents_system_insert ON public.user_consents
  FOR INSERT
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- tenant_domains: public SELECT (pre-context routing), admin writes ---

CREATE POLICY tenant_domains_public_read ON public.tenant_domains
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY tenant_domains_platform_admin ON public.tenant_domains
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- tenant_counters: T-ISOLATE, system + in-transaction service writes --

CREATE POLICY tenant_counters_tenant_isolation ON public.tenant_counters
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY tenant_counters_write ON public.tenant_counters
  FOR ALL
  USING (tenant_id = (SELECT public.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY tenant_counters_platform_admin ON public.tenant_counters
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- tenant_status_changes: staff SELECT, no app-role writes (trigger only)

CREATE POLICY tenant_status_changes_staff_read ON public.tenant_status_changes
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
-- SELECT only, deliberately not FOR ALL: nothing writes here yet (the
-- trigger that will is still deferred, see header), including the platform
-- admin. An ALL/bypass policy here would let admin INSERT arbitrary history
-- directly — UPDATE/DELETE are already blocked by the immutability trigger
-- regardless of policy, but INSERT is not, so the policy has to be the guard.
CREATE POLICY tenant_status_changes_platform_read ON public.tenant_status_changes
  FOR SELECT
  USING ((SELECT public.is_platform_admin()) OR (SELECT public.app_is_platform()));
--> statement-breakpoint

-- ---- tenant_billing: staff SELECT, platform/finance/system UPDATE --------

CREATE POLICY tenant_billing_staff_read ON public.tenant_billing
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_billing_platform_read ON public.tenant_billing
  FOR SELECT
  USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY tenant_billing_finance_write ON public.tenant_billing
  FOR UPDATE
  USING (public.app_role() IN ('platform_admin', 'platform_finance') OR (SELECT public.app_is_system()))
  WITH CHECK (public.app_role() IN ('platform_admin', 'platform_finance') OR (SELECT public.app_is_system()));
--> statement-breakpoint

-- ---- platform_settings: staff SELECT, platform_admin writes --------------

CREATE POLICY platform_settings_read ON public.platform_settings
  FOR SELECT
  USING (
    (SELECT public.app_is_platform())
    OR (SELECT public.app_is_system())
    OR (SELECT public.app_is_staff())
  );
--> statement-breakpoint
CREATE POLICY platform_settings_platform_admin_write ON public.platform_settings
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- ---- platform_counters: system + platform only ----------------------------

CREATE POLICY platform_counters_system ON public.platform_counters
  FOR ALL
  USING ((SELECT public.app_is_system()) OR (SELECT public.app_is_platform()))
  WITH CHECK ((SELECT public.app_is_system()) OR (SELECT public.app_is_platform()));
--> statement-breakpoint

-- ---- vat_rates: G-REFERENCE ------------------------------------------------

CREATE POLICY vat_rates_read_all ON public.vat_rates
  FOR SELECT
  USING (true);
--> statement-breakpoint
CREATE POLICY vat_rates_finance_write ON public.vat_rates
  FOR ALL
  USING (public.app_role() IN ('platform_admin', 'platform_finance'))
  WITH CHECK (public.app_role() IN ('platform_admin', 'platform_finance'));
--> statement-breakpoint

-- ---- tenant_transfers: staff SELECT, platform_admin/finance write --------

CREATE POLICY tenant_transfers_staff_read ON public.tenant_transfers
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY tenant_transfers_finance_write ON public.tenant_transfers
  FOR ALL
  USING (public.app_role() IN ('platform_admin', 'platform_finance'))
  WITH CHECK (public.app_role() IN ('platform_admin', 'platform_finance'));
--> statement-breakpoint

-- ============================================================================
-- Grants. Same discipline as 0002: table by table, no ALTER DEFAULT PRIVILEGES.
-- ============================================================================

GRANT SELECT ON
  public.partner_statuses, public.payout_methods, public.device_platforms, public.counter_types,
  public.consent_types, public.tenant_transfer_statuses, public.setting_value_types, public.setting_override_scopes
TO ae_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON
  public.partner_statuses, public.payout_methods, public.device_platforms, public.counter_types,
  public.consent_types, public.tenant_transfer_statuses, public.setting_value_types, public.setting_override_scopes
TO ae_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.partners TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.partner_payout_accounts TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.user_profiles TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_devices TO ae_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.auth_refresh_tokens TO ae_app;
--> statement-breakpoint
-- Append-only.
GRANT SELECT, INSERT ON public.user_consents TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_domains TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_counters TO ae_app;
--> statement-breakpoint
-- Append-only (no policy permits it, but keep the grant surface honest too).
GRANT SELECT, INSERT ON public.tenant_status_changes TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_billing TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.platform_settings TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.platform_counters TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.vat_rates TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_transfers TO ae_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.app_role() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_is_platform() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_is_system() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_is_tenant_admin() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_is_staff() TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.setting_value_matches_type(jsonb, text) TO ae_app;

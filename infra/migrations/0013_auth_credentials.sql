-- 0013_auth_credentials
--
-- Auth module (Week 2): Google OAuth and email+password as secondary
-- credentials on the existing phone-anchored `users` row (docs/specs/
-- schema.md §2.7 keeps phone_e164 NOT NULL — neither method can create a
-- phone-less account, so this migration only adds two nullable columns, no
-- new tables).
--
-- Every insert here happens before `app.user_id` exists (login/refresh have
-- no request context yet), which is exactly the case §13.5 carves out
-- SECURITY DEFINER functions for. `auth_resolve_or_create_by_phone` and
-- `auth_rotate_refresh_token` are the two functions schema.md §13.5 already
-- names; `auth_get_by_google_id`, `auth_get_credential_by_email` and
-- `auth_finalize_session` are new, needed because Google/email login and
-- device/refresh-token issuance aren't in the original spec. All five follow
-- the is_conversation_participant/is_blocked_between precedent from 0009:
-- SECURITY DEFINER, owned by ae_rls_bypass, search_path pinned, EXECUTE
-- granted to ae_app, base table grants given to ae_rls_bypass separately
-- (BYPASSRLS only bypasses policies, not table-level grants).
--
-- Linking Google/email to an *already authenticated* account needs none of
-- this: the existing owner-UPDATE policy on `users` (§2.7) already covers
-- the new columns, since RLS is row-level, not column-level.

-- ============================================================================
-- users: two new secondary-credential columns
-- ============================================================================

ALTER TABLE public.users ADD COLUMN password_hash text;
--> statement-breakpoint
ALTER TABLE public.users ADD COLUMN google_id text;
--> statement-breakpoint

-- One live Google identity per account, same "release on close" rule as
-- phone/email (§2.7's indexes).
CREATE UNIQUE INDEX users_google_id_key ON public.users (google_id)
  WHERE google_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- ============================================================================
-- Helper functions (pre-auth identity resolution & session issuance)
-- ============================================================================

-- The spec's sanctioned auth_upsert_user_by_phone (§13.5), kept its name.
-- Creates the user (+ user_profiles) on first verified OTP, or touches
-- phone_verified_at on a returning one. Never issues a session itself —
-- callers must still check blacklist_severity before calling
-- auth_finalize_session, so a flagged identity never gets tokens.
CREATE OR REPLACE FUNCTION public.auth_resolve_or_create_by_phone(p_phone text)
RETURNS TABLE(user_id uuid, is_new boolean, blacklist_severity text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
  v_is_new boolean := false;
BEGIN
  SELECT u.id INTO v_user_id FROM public.users u
    WHERE u.phone_e164 = p_phone AND u.deleted_at IS NULL;

  IF v_user_id IS NULL THEN
    INSERT INTO public.users (phone_e164, phone_verified_at)
    VALUES (p_phone, now())
    RETURNING id INTO v_user_id;

    -- Placeholder, digits only (no language-specific word — rule 6):
    -- the real display name is set later, once profile editing exists.
    INSERT INTO public.user_profiles (user_id, display_name)
    VALUES (v_user_id, right(p_phone, 4));

    v_is_new := true;
  ELSE
    UPDATE public.users SET phone_verified_at = COALESCE(phone_verified_at, now())
      WHERE id = v_user_id;
  END IF;

  RETURN QUERY
    SELECT v_user_id, v_is_new, public.active_blacklist_severity(v_user_id, p_phone);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_resolve_or_create_by_phone(text) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Shared by every identity-resolution function below: the highest-severity
-- active blacklist_entries row for this user/phone, or NULL. Not itself
-- SECURITY DEFINER — it's only ever called from inside one.
CREATE OR REPLACE FUNCTION public.active_blacklist_severity(p_user_id uuid, p_phone text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT bl.severity_code
  FROM public.blacklist_entries bl
  WHERE bl.status_code = 'active'
    AND ((p_user_id IS NOT NULL AND bl.user_id = p_user_id) OR bl.phone_e164 = p_phone)
  ORDER BY CASE bl.severity_code
    WHEN 'terminated' THEN 4 WHEN 'banned' THEN 3 WHEN 'restricted' THEN 2 ELSE 1
  END DESC
  LIMIT 1
$$;
--> statement-breakpoint
ALTER FUNCTION public.active_blacklist_severity(uuid, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Read-only; login only (never creates an account — Google can't satisfy the
-- NOT NULL phone anchor). No match returns zero rows.
CREATE OR REPLACE FUNCTION public.auth_get_by_google_id(p_google_id text)
RETURNS TABLE(user_id uuid, blacklist_severity text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, public.active_blacklist_severity(u.id, u.phone_e164)
  FROM public.users u
  WHERE u.google_id = p_google_id AND u.deleted_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_get_by_google_id(text) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Read-only; returns the hash so the API can argon2-verify it in Node
-- (Postgres has no argon2). No match, or a match with no password set,
-- returns password_hash = NULL — the caller treats both as invalid
-- credentials, never distinguishing "no such email" from "wrong password".
CREATE OR REPLACE FUNCTION public.auth_get_credential_by_email(p_email text)
RETURNS TABLE(user_id uuid, password_hash text, blacklist_severity text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.password_hash, public.active_blacklist_severity(u.id, u.phone_e164)
  FROM public.users u
  WHERE lower(u.email) = lower(p_email) AND u.deleted_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_get_credential_by_email(text) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- Finishes a login after identity is resolved and the blacklist check has
-- already passed (callers never call this for a flagged identity). Grants
-- tenant membership (extending §2.11's "first authenticated write" implicit-
-- membership rule to "first authenticated login" — logging in is the
-- earliest authenticated moment there is), upserts the device row (a
-- push_token already seen on another account moves here, matching §2.9's
-- "never push to the wrong person" intent), and inserts the first refresh
-- token of a new rotation family.
CREATE OR REPLACE FUNCTION public.auth_finalize_session(
  p_user_id uuid,
  p_tenant_id uuid,
  p_device jsonb,
  p_token_hash text,
  p_family_id uuid,
  p_expires_at timestamptz,
  p_created_ip inet,
  p_user_agent text
)
RETURNS TABLE(member_id uuid, role_code text, device_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_member_id uuid;
  v_role_code text;
  v_device_id uuid;
  v_fingerprint text := p_device ->> 'fingerprintHash';
  v_push_token text := p_device ->> 'pushToken';
BEGIN
  INSERT INTO public.tenant_members (tenant_id, user_id, role_code, last_active_at)
  VALUES (p_tenant_id, p_user_id, 'member', now())
  ON CONFLICT (user_id, tenant_id) DO UPDATE
    SET last_active_at = now(), status_code = 'active'
  RETURNING id, role_code INTO v_member_id, v_role_code;

  IF v_fingerprint IS NOT NULL THEN
    SELECT ud.id INTO v_device_id FROM public.user_devices ud
      WHERE ud.fingerprint_hash = v_fingerprint AND ud.user_id = p_user_id;
  END IF;
  IF v_device_id IS NULL AND v_push_token IS NOT NULL THEN
    SELECT ud.id INTO v_device_id FROM public.user_devices ud WHERE ud.push_token = v_push_token;
  END IF;

  IF v_device_id IS NULL THEN
    INSERT INTO public.user_devices
      (user_id, platform_code, push_token, app_version, device_model, fingerprint_hash)
    VALUES (
      p_user_id, p_device ->> 'platformCode', v_push_token,
      p_device ->> 'appVersion', p_device ->> 'deviceModel', v_fingerprint
    )
    RETURNING id INTO v_device_id;
  ELSE
    UPDATE public.user_devices SET
      user_id = p_user_id,
      last_seen_at = now(),
      revoked_at = NULL,
      push_token = COALESCE(v_push_token, push_token),
      app_version = COALESCE(p_device ->> 'appVersion', app_version),
      device_model = COALESCE(p_device ->> 'deviceModel', device_model)
    WHERE id = v_device_id;
  END IF;

  INSERT INTO public.auth_refresh_tokens
    (user_id, device_id, token_hash, family_id, expires_at, created_ip, user_agent)
  VALUES (p_user_id, v_device_id, p_token_hash, p_family_id, p_expires_at, p_created_ip, p_user_agent);

  UPDATE public.users SET last_login_at = now() WHERE id = p_user_id;

  RETURN QUERY SELECT v_member_id, v_role_code, v_device_id;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_finalize_session(uuid, uuid, jsonb, text, uuid, timestamptz, inet, text)
  OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- The spec's sanctioned auth_rotate_refresh_token (§13.5), extended with
-- tenant_id: refresh tokens aren't tenant-scoped (§2.10), so the caller's
-- *current* tenant context decides which membership/role the new access
-- token gets, same implicit-membership rule as auth_finalize_session.
-- Reuse of an already-rotated token revokes the whole family and raises, so
-- the API can force re-login instead of minting a token from a stolen one.
-- Custom SQLSTATEs (AE00x, outside Postgres's own range) let the service
-- layer tell invalid/reused/expired apart without parsing message text.
CREATE OR REPLACE FUNCTION public.auth_rotate_refresh_token(
  p_old_token_hash text,
  p_new_token_hash text,
  p_new_expires_at timestamptz,
  p_tenant_id uuid,
  p_created_ip inet,
  p_user_agent text
)
RETURNS TABLE(user_id uuid, member_id uuid, role_code text, device_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.auth_refresh_tokens%ROWTYPE;
  v_new_id uuid;
  v_member_id uuid;
  v_role_code text;
BEGIN
  SELECT * INTO v_row FROM public.auth_refresh_tokens WHERE token_hash = p_old_token_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refresh_token_invalid' USING ERRCODE = 'AE001';
  END IF;

  IF v_row.revoked_at IS NOT NULL THEN
    UPDATE public.auth_refresh_tokens SET revoked_at = now()
      WHERE family_id = v_row.family_id AND revoked_at IS NULL;
    RAISE EXCEPTION 'refresh_token_reused' USING ERRCODE = 'AE002';
  END IF;

  IF v_row.expires_at < now() THEN
    RAISE EXCEPTION 'refresh_token_expired' USING ERRCODE = 'AE003';
  END IF;

  INSERT INTO public.auth_refresh_tokens
    (user_id, device_id, token_hash, family_id, expires_at, created_ip, user_agent)
  VALUES (v_row.user_id, v_row.device_id, p_new_token_hash, v_row.family_id, p_new_expires_at, p_created_ip, p_user_agent)
  RETURNING id INTO v_new_id;

  UPDATE public.auth_refresh_tokens SET revoked_at = now(), replaced_by_id = v_new_id
    WHERE id = v_row.id;

  INSERT INTO public.tenant_members (tenant_id, user_id, role_code, last_active_at)
  VALUES (p_tenant_id, v_row.user_id, 'member', now())
  ON CONFLICT (user_id, tenant_id) DO UPDATE
    SET last_active_at = now(), status_code = 'active'
  RETURNING id, role_code INTO v_member_id, v_role_code;

  RETURN QUERY SELECT v_row.user_id, v_member_id, v_role_code, v_row.device_id;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_rotate_refresh_token(text, text, timestamptz, uuid, inet, text)
  OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================

-- Base table grants for ae_rls_bypass (BYPASSRLS skips policies, not the
-- underlying GRANTs — same requirement as 0009's is_blocked_between).
GRANT SELECT, INSERT, UPDATE ON public.users TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.user_profiles TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.tenant_members TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.user_devices TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.auth_refresh_tokens TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.blacklist_entries TO ae_rls_bypass;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.auth_resolve_or_create_by_phone(text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_get_by_google_id(text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_get_credential_by_email(text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_finalize_session(uuid, uuid, jsonb, text, uuid, timestamptz, inet, text) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_rotate_refresh_token(text, text, timestamptz, uuid, inet, text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9): every OTP/password number lives here, read
-- through SettingsService (apps/api/src/settings). tenant_override_scope_code
-- = 'none' — these are security policy, not tunable by tenant operators.
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('otp_code_length', '6', 'integer', 'digits', 4, 8, 'none',
   'Length of the numeric OTP code sent for phone verification.'),
  ('otp_ttl_seconds', '300', 'integer', 'seconds', 60, 1800, 'none',
   'How long an OTP code remains valid after it is sent.'),
  ('otp_max_attempts', '3', 'integer', 'attempts', 1, 10, 'none',
   'Wrong-code attempts allowed before an OTP is invalidated.'),
  ('otp_resend_cooldown_seconds', '60', 'integer', 'seconds', 10, 600, 'none',
   'Minimum time between two OTP requests for the same phone.'),
  ('otp_max_requests_per_phone_per_day', '5', 'integer', 'requests', 1, 50, 'none',
   'Maximum OTP requests for one phone number per day.'),
  ('otp_max_requests_per_ip_per_day', '20', 'integer', 'requests', 1, 200, 'none',
   'Maximum OTP requests from one IP address per day.'),
  ('auth_password_min_length', '10', 'integer', 'characters', 6, 128, 'none',
   'Minimum password length for email+password registration.');

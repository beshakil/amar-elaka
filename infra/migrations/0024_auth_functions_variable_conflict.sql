-- 0024_auth_functions_variable_conflict
--
-- auth_finalize_session and auth_rotate_refresh_token (0013) RETURN TABLE
-- columns named role_code / user_id, and their bodies also use tenant_members
-- columns of the same names (`RETURNING id, role_code`,
-- `ON CONFLICT (user_id, tenant_id)`). PL/pgSQL rejects those references as
-- ambiguous at call time, so every login and every token refresh failed with
-- "column reference \"role_code\" is ambiguous". Found by
-- test/auth-security-definer-functions.db-spec.ts on its first run against a
-- real database.
--
-- Second bug, same function: on reuse of a superseded refresh token,
-- auth_rotate_refresh_token revoked the token family and then RAISEd, which
-- rolled the revocation back — theft detection never took effect. It now
-- revokes and returns no row instead (see the comment in its body).
--
-- Fix: the same bodies, verbatim apart from that branch, plus
-- `#variable_conflict use_column`, so an
-- ambiguous name means the table column. Every variable in these functions is
-- v_/p_-prefixed and the OUT columns are only written by RETURN QUERY, so
-- nothing relied on the other resolution. Signatures, owner (ae_rls_bypass)
-- and grants are unchanged; CREATE OR REPLACE keeps them.
--
-- Only the owner may replace a function, and ae_migrator is NOINHERIT
-- (infra/db/bootstrap-roles.sql), so it must SET ROLE to ae_rls_bypass for
-- the replacement and RESET afterwards. Any later migration that redefines an
-- ae_rls_bypass-owned function needs the same wrapper.

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
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
#variable_conflict use_column
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
#variable_conflict use_column
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

  -- Reuse of a superseded token: revoke the whole family and return NO row.
  -- It used to RAISE 'AE002' here, which rolled back this very UPDATE, so the
  -- family was never revoked. The API maps "no row" to REFRESH_TOKEN_REUSED
  -- after letting its transaction commit.
  IF v_row.revoked_at IS NOT NULL THEN
    UPDATE public.auth_refresh_tokens SET revoked_at = now()
      WHERE family_id = v_row.family_id AND revoked_at IS NULL;
    RETURN;
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
RESET ROLE;

-- 0025_auth_self_credential_writes
--
-- Linking a Google account (POST /auth/google while signed in) and adding an
-- email + password (POST /auth/email/register) both did a plain
-- `UPDATE users ... WHERE id = <caller>` as ae_app. `users` only has a
-- self-READ policy (0002), so RLS silently matched zero rows: the API
-- answered "linked" / 204 and nothing was saved. Found by auth.e2e-spec.ts
-- on its first real run.
--
-- A self-UPDATE policy on users would be the wrong fix: it would let a user
-- rewrite their own platform_role_code, status or phone. Instead, two narrow
-- SECURITY DEFINER functions (owned by ae_rls_bypass, like 0013's auth
-- functions) that each write only their own columns, and only for the
-- signed-in user: the row is current_user_id() (app.user_id, set from the
-- verified JWT), never a caller-supplied id. Each returns whether a row
-- changed, so the API can refuse instead of reporting a silent no-op.
-- A unique violation (the Google account / email is already someone else's)
-- still surfaces as SQLSTATE 23505.

CREATE OR REPLACE FUNCTION public.auth_link_google(p_google_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.users
    SET google_id = p_google_id
    WHERE id = public.current_user_id() AND deleted_at IS NULL;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_link_google(text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_link_google(text) TO ae_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.auth_set_email_credential(p_email text, p_password_hash text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.users
    SET email = lower(p_email), password_hash = p_password_hash
    WHERE id = public.current_user_id() AND deleted_at IS NULL;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.auth_set_email_credential(text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_set_email_credential(text, text) TO ae_app;

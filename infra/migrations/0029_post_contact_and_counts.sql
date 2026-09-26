-- 0029_post_contact_and_counts
--
-- What the mobile post flows need from posts (ADR 032):
--
--   posts.show_whatsapp            the seller also takes WhatsApp on the contact
--                                  phone (a toggle beside show_phone/allow_chat).
--   posts contact CHECKs           the contact phone is a BD mobile number and the
--                                  name isn't blank (the columns exist since 0005,
--                                  unused until now).
--   my_post_refs(…, p_hidden, …)   the "hidden" tab: hidden posts only, or none.
--   my_post_counts()               the per-tab counts of the caller's posts.
--   my_post_moderation_history()   now also gives a rejection's note to the
--                                  author: the notification already carries it
--                                  (ADR 030), and the rejected tab shows it.
--   moderation_typical_review_hours the "under review, usually within X hours"
--                                  promise (tenant-overridable).
--
-- No table is added; the functions follow 0026's SECURITY DEFINER pattern.

ALTER TABLE public.posts ADD COLUMN show_whatsapp boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.posts ADD CONSTRAINT posts_contact_phone_e164_ck
  CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+8801[3-9][0-9]{8}$');
--> statement-breakpoint
ALTER TABLE public.posts ADD CONSTRAINT posts_contact_name_ck
  CHECK (contact_name IS NULL OR btrim(contact_name) <> '');
--> statement-breakpoint

-- ============================================================================
-- my_post_refs (+ hidden filter), my_post_counts, my_post_moderation_history
-- ============================================================================

-- The old signature and the history function belong to ae_rls_bypass: only
-- it may drop or redefine them (ae_migrator is NOINHERIT, see 0024).
SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
DROP FUNCTION public.my_post_refs(text[], uuid, integer);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.my_post_moderation_history(target_post_id uuid)
RETURNS TABLE (action_code text, reason_code text, reason_text text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    ma.action_code,
    ma.reason_code,
    CASE WHEN ma.action_code IN ('rejected', 'removed', 'restored') THEN ma.reason_text ELSE NULL END,
    ma.created_at
  FROM public.moderation_actions ma
  WHERE ma.post_id = target_post_id
    AND ma.tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = target_post_id
        AND p.tenant_id = (SELECT public.current_tenant_id())
        AND p.author_member_id = (SELECT public.current_member_id())
    )
  ORDER BY ma.id DESC
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- p_hidden: NULL = either, true = only hidden, false = only not hidden.
CREATE FUNCTION public.my_post_refs(p_statuses text[], p_hidden boolean, p_before uuid, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.id, p.tenant_id
  FROM public.posts p
  JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.id = p.author_member_id
  WHERE tm.user_id = public.current_user_id()
    AND p.deleted_at IS NULL
    AND (p_statuses IS NULL OR p.status_code = ANY (p_statuses))
    AND (p_hidden IS NULL OR p.hidden_by_owner = p_hidden)
    AND (p_before IS NULL OR p.id < p_before)
  ORDER BY p.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_post_refs(text[], boolean, uuid, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- One row per bucket the "my posts" tabs show: each status among the posts
-- not hidden, and `hidden` for every hidden one whatever its status.
CREATE FUNCTION public.my_post_counts()
RETURNS TABLE (bucket text, post_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p.hidden_by_owner THEN 'hidden' ELSE p.status_code END, count(*)::integer
  FROM public.posts p
  JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.id = p.author_member_id
  WHERE tm.user_id = public.current_user_id()
    AND p.deleted_at IS NULL
  GROUP BY 1
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_post_counts() OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_post_refs(text[], boolean, uuid, integer) TO ae_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_post_counts() TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('moderation_typical_review_hours', '12', 'integer', 'hours', 1, 168, 'tenant_admin',
   'What a seller is told after submitting a post that waits for review: "usually within X hours".');

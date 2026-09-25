-- 0026_posts_module
--
-- What the posts module (apps/api/src/posts) needs from the database. No new
-- tables and no column changes:
--
--   1. A `text_array` setting type, for post_rereview_fields (which edits send
--      a live post back to moderation).
--   2. Post settings (CLAUDE.md rule 9): media per post, per-user limits,
--      title/description length, idempotency window, /posts/me page size.
--   3. Four narrow SECURITY DEFINER functions (owned by ae_rls_bypass, like
--      0023), because a post may belong to a neighbouring tenant (§13.26):
--        ensure_my_membership(tenant)  the implicit membership a buffer-zone
--                                      post needs in its owning tenant (Q4)
--        my_membership_in(tenant)      the same lookup without creating one
--        post_tenant_of(post)          which tenant to read a post in
--        my_post_refs(...)             the caller's own posts across tenants
--        my_post_stats(since)          per-user limit counters across tenants
--      Each acts only for current_user_id() (app.user_id, from the verified
--      JWT), never for a caller-supplied user, and returns ids/codes, not rows.

-- ============================================================================
-- text_array setting type
-- ============================================================================

INSERT INTO public.setting_value_types (code, label_key, sort_order) VALUES
  ('text_array', 'enum.setting_value_types.text_array', 70);
--> statement-breakpoint

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
    WHEN 'text_array' THEN
      jsonb_typeof(value) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value) elem WHERE jsonb_typeof(elem) <> 'string'
      )
    ELSE false
  END
$$;
--> statement-breakpoint

-- ============================================================================
-- Settings. Defaults sized for Bangladesh: mid-range Android phones on mobile
-- data, so photos are capped and a flaky connection's retry window (the
-- idempotency TTL) is generous.
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('post_max_media', '10', 'integer', 'count', 1, 30, 'platform',
   'Most photos one post may carry.'),
  ('post_max_active_per_user', '50', 'integer', 'count', 1, 1000, 'platform',
   'Most posts one member may have pending or live at once, across all tenants.'),
  ('post_max_per_day_per_user', '10', 'integer', 'count', 1, 200, 'platform',
   'Most posts one member may create in any rolling 24 hours, across all tenants.'),
  ('post_rereview_fields', '["title", "media", "price", "category"]', 'text_array', NULL, NULL, NULL, 'platform',
   'Editing any of these on a live post sends it back to moderation (pre-moderated tenants) or flags it for re-review (post-moderated). Values: title, description, media, price, category, fields, location.'),
  ('post_title_max_length', '120', 'integer', 'characters', 20, 300, 'none',
   'Longest post title.'),
  ('post_description_max_length', '5000', 'integer', 'characters', 200, 20000, 'none',
   'Longest post description.'),
  ('post_idempotency_ttl_hours', '24', 'integer', 'hours', 1, 168, 'none',
   'How long an Idempotency-Key on POST /posts keeps returning the same post, so a retry on a flaky connection never creates a duplicate.'),
  ('post_list_page_size_default', '20', 'integer', 'count', 1, 100, 'none',
   'Posts per page on GET /posts/me when the client does not ask.'),
  ('post_list_page_size_max', '50', 'integer', 'count', 1, 200, 'none',
   'Largest page GET /posts/me will return.');
--> statement-breakpoint

-- ============================================================================
-- Membership in the owning tenant
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ensure_my_membership(p_tenant_id uuid)
RETURNS TABLE (member_id uuid, role_code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_user_id uuid := public.current_user_id();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ensure_my_membership needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    INSERT INTO public.tenant_members AS tm (tenant_id, user_id, role_code, last_active_at)
    VALUES (p_tenant_id, v_user_id, 'member', now())
    ON CONFLICT (user_id, tenant_id) DO UPDATE SET last_active_at = now()
    RETURNING tm.id, tm.role_code;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.ensure_my_membership(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ensure_my_membership(uuid) TO ae_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.my_membership_in(p_tenant_id uuid)
RETURNS TABLE (member_id uuid, role_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT tm.id, tm.role_code
  FROM public.tenant_members tm
  WHERE tm.tenant_id = p_tenant_id
    AND tm.user_id = public.current_user_id()
    AND tm.deleted_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_membership_in(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_membership_in(uuid) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Which tenant a post lives in
-- ============================================================================

-- Only the tenant id, which is public (tenants are publicly readable): the
-- caller still reads the post itself in that tenant's context, through the
-- ordinary RLS policies. Legal-hold posts are invisible here too.
CREATE OR REPLACE FUNCTION public.post_tenant_of(p_post_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.tenant_id FROM public.posts p
  WHERE p.id = p_post_id AND p.deletion_reason_code IS DISTINCT FROM 'legal_hold'
$$;
--> statement-breakpoint
ALTER FUNCTION public.post_tenant_of(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.post_tenant_of(uuid) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- The caller's own posts, across every tenant they post in
-- ============================================================================

-- Newest first, keyset-paged on id (uuid v7 = creation order). Deleted and
-- legal-hold posts are excluded; hidden ones are included (owner's view).
-- p_statuses NULL = every status. The page size is the caller's, already
-- clamped to post_list_page_size_max by the API.
CREATE OR REPLACE FUNCTION public.my_post_refs(p_statuses text[], p_before uuid, p_limit integer)
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
    AND (p_before IS NULL OR p.id < p_before)
  ORDER BY p.id DESC
  LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_post_refs(text[], uuid, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_post_refs(text[], uuid, integer) TO ae_app;
--> statement-breakpoint

-- Counters for post_max_active_per_user and post_max_per_day_per_user.
CREATE OR REPLACE FUNCTION public.my_post_stats(p_created_since timestamptz)
RETURNS TABLE (active_count integer, created_since_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    count(*) FILTER (WHERE p.status_code IN ('pending', 'live') AND p.deleted_at IS NULL)::integer,
    count(*) FILTER (WHERE p.created_at >= p_created_since)::integer
  FROM public.posts p
  JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.id = p.author_member_id
  WHERE tm.user_id = public.current_user_id()
$$;
--> statement-breakpoint
ALTER FUNCTION public.my_post_stats(timestamptz) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_post_stats(timestamptz) TO ae_app;

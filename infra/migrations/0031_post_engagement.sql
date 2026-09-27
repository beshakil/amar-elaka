-- 0031_post_engagement
--
-- Post detail, contact tracking, view counts, share links and reports
-- (ADR 036):
--
--   post_short_links             TENANT-SCOPED: one share code per post, for
--                                /s/:code links. Codes are unique across
--                                tenants. Anyone who can see the post may
--                                create its code (the policy checks the post
--                                through the viewer's own posts policies).
--   resolve_short_link(code)     which post a code names, before any tenant
--                                context exists (post_tenant_of pattern):
--                                ids only.
--   add_post_views(ids, counts)  the view-count flush: adds batched counts
--                                to posts.view_count and nothing else.
--   post_seller_card(post, min)  what a buyer may know about a seller: name,
--                                member since, badges, store, response time.
--                                Never the trust score itself.
--   post_engagement_counts(post) the owner's and staff's counters: contacts
--                                by channel and saves (neither is readable
--                                by the owner under RLS), and views.
--   report_post(post, reason, details)
--                                files a report as the caller and, at
--                                auto_hide_report_threshold distinct
--                                reporters, takes a live post back to
--                                pending, audited (moderation_actions
--                                auto_hidden) and queued (source 'report').
--
-- Plus lookup codes (auto_hidden action, community_reports reason, the
-- flush-post-views scheduled job), the
-- moderation queue's report source/reason, the per-post lead index the
-- counters read, and the settings. Every function is SECURITY DEFINER owned
-- by ae_rls_bypass, pins search_path, and acts only on a post in the
-- caller's current tenant.

-- ============================================================================
-- Lookup codes and constraint widening
-- ============================================================================

INSERT INTO public.moderation_action_types (code, label_key, sort_order) VALUES
  ('auto_hidden', 'enum.moderation_action_types.auto_hidden', 75);
--> statement-breakpoint
INSERT INTO public.moderation_reasons (code, label_key, sort_order) VALUES
  ('community_reports', 'enum.moderation_reasons.community_reports', 2);
--> statement-breakpoint

-- The system acts without a user for an auto-hide, as for spam_auto_deleted.
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_actor_required_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_actor_required_ck
  CHECK (actor_user_id IS NOT NULL OR action_code IN ('spam_auto_deleted', 'auto_hidden'));
--> statement-breakpoint

ALTER TABLE public.moderation_queue_items DROP CONSTRAINT moderation_queue_items_source_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_queue_items ADD CONSTRAINT moderation_queue_items_source_ck
  CHECK (source_code IN ('submission', 'sample', 'rereview', 'report'));
--> statement-breakpoint
ALTER TABLE public.moderation_queue_items DROP CONSTRAINT moderation_queue_items_reasons_ck;
--> statement-breakpoint
ALTER TABLE public.moderation_queue_items ADD CONSTRAINT moderation_queue_items_reasons_ck
  CHECK (reasons <@ ARRAY[
    'low_trust', 'pre_moderation', 'outside_boundary', 'resubmission',
    'banned_keyword', 'contact_info', 'link_spam', 'duplicate', 'price_outlier',
    'sample', 'rereview', 'reported'
  ]::text[]);
--> statement-breakpoint

-- The worker job that flushes Redis view counts (apps/api/src/queue/queue.types.ts).
INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('flush-post-views', 'enum.scheduled_jobs.flush-post-views', 60);
--> statement-breakpoint

-- The owner's per-channel counters (post_engagement_counts).
CREATE INDEX lead_events_tenant_post_channel_idx ON public.lead_events (tenant_id, post_id, channel_code)
  WHERE post_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- post_short_links
-- ============================================================================

CREATE TABLE public.post_short_links (
  id          uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT public.current_tenant_id(),
  post_id     uuid        NOT NULL,
  code        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_short_links_pk PRIMARY KEY (id),
  CONSTRAINT post_short_links_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT post_short_links_tenant_id_post_id_fk FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE CASCADE,
  -- Lowercase letters and digits; the length is share_code_length (checked
  -- loosely here so the setting can change without a migration).
  CONSTRAINT post_short_links_code_ck CHECK (code ~ '^[a-z0-9]{4,32}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX post_short_links_code_uq ON public.post_short_links (code);
--> statement-breakpoint
-- One code per post; also the tenant_id index.
CREATE UNIQUE INDEX post_short_links_tenant_post_uq ON public.post_short_links (tenant_id, post_id);
--> statement-breakpoint
CREATE TRIGGER post_short_links_set_updated_at BEFORE UPDATE ON public.post_short_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.post_short_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.post_short_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A code is no secret (it's in every shared link); reading it gives nothing
-- the post's own policies don't.
CREATE POLICY post_short_links_tenant_read ON public.post_short_links
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
-- Whoever can see the post can create its code. The EXISTS runs under the
-- inserter's own posts policies, so a visitor can share a live post but
-- never mint a code for someone's draft.
CREATE POLICY post_short_links_viewer_insert ON public.post_short_links
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = post_short_links.post_id AND p.tenant_id = post_short_links.tenant_id
    )
  );
--> statement-breakpoint
CREATE POLICY post_short_links_platform_admin ON public.post_short_links
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT ON public.post_short_links TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.post_short_links TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- Grants the functions below need as ae_rls_bypass (BYPASSRLS, NOINHERIT)
-- ============================================================================

GRANT UPDATE ON public.posts TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.reports TO ae_rls_bypass;
--> statement-breakpoint
GRANT INSERT ON public.moderation_actions TO ae_rls_bypass;
--> statement-breakpoint
GRANT UPDATE ON public.moderation_queue_items TO ae_rls_bypass;
--> statement-breakpoint
GRANT INSERT ON public.outbox_events TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.lead_events, public.saved_posts, public.member_trust_scores,
  public.seller_profiles, public.store_members, public.categories, public.category_field_schemas
  TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- resolve_short_link
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_short_link(p_code text)
RETURNS TABLE (tenant_id uuid, post_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT l.tenant_id, l.post_id FROM public.post_short_links l WHERE l.code = p_code
$$;
--> statement-breakpoint
ALTER FUNCTION public.resolve_short_link(text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.resolve_short_link(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_short_link(text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- add_post_views
-- ============================================================================

-- The worker's batched flush of Redis view counters (ADR 036), system role
-- only. view_count is search "noise" (0020), so this never reindexes a post.
CREATE OR REPLACE FUNCTION public.add_post_views(p_post_ids uuid[], p_counts integer[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'add_post_views: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(p_post_ids) IS DISTINCT FROM cardinality(p_counts) THEN
    RAISE EXCEPTION 'add_post_views: ids and counts differ in length' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.posts p
  SET view_count = p.view_count + v.n
  FROM (
    SELECT u.id, sum(u.n)::integer AS n
    FROM unnest(p_post_ids, p_counts) AS u(id, n)
    WHERE u.n > 0
    GROUP BY u.id
  ) v
  WHERE p.id = v.id AND p.deleted_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.add_post_views(uuid[], integer[]) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.add_post_views(uuid[], integer[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.add_post_views(uuid[], integer[]) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- post_seller_card
-- ============================================================================

-- Only for a post the caller may see: public (live/sold, not hidden, deleted
-- or scrubbed), or the caller's own, or staff. p_trusted_min is the score a
-- member needs for the "trusted" badge (trust_auto_approve_threshold, read
-- by the API through SettingsService); only the yes/no leaves the database.
CREATE OR REPLACE FUNCTION public.post_seller_card(p_post_id uuid, p_trusted_min smallint)
RETURNS TABLE (
  display_name             text,
  member_since             timestamptz,
  phone_verified           boolean,
  trusted                  boolean,
  store_id                 uuid,
  store_slug               text,
  store_name_bn            text,
  store_name_en            text,
  store_verified           boolean,
  response_rate_pct        numeric,
  median_response_seconds  integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH post AS (
    SELECT p.tenant_id, p.author_member_id, p.store_id, p.contact_name
    FROM public.posts p
    WHERE p.id = p_post_id
      AND p.tenant_id = public.current_tenant_id()
      AND p.author_member_id IS NOT NULL
      AND p.scrubbed_at IS NULL
      AND (
        (p.status_code IN ('live', 'sold') AND NOT p.hidden_by_owner AND p.deleted_at IS NULL)
        OR p.author_member_id = public.current_member_id()
        OR public.app_is_staff()
      )
  )
  SELECT
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(post.contact_name), '')),
    u.created_at,
    u.phone_verified_at IS NOT NULL,
    coalesce(ts.override_score, ts.score) >= p_trusted_min,
    st.id, st.slug, st.name_bn, st.name_en, st.is_verified,
    sp.response_rate_pct, sp.median_response_seconds
  FROM post
  JOIN public.tenant_members tm ON tm.tenant_id = post.tenant_id AND tm.id = post.author_member_id
  JOIN public.users u ON u.id = tm.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = u.id
  LEFT JOIN public.member_trust_scores ts ON ts.tenant_id = post.tenant_id AND ts.member_id = tm.id
  LEFT JOIN public.seller_profiles sp ON sp.tenant_id = post.tenant_id AND sp.member_id = tm.id
  -- The post's own store, else the author's own active store in this tenant.
  LEFT JOIN LATERAL (
    SELECT s.id, s.slug, s.name_bn, s.name_en, s.is_verified
    FROM public.stores s
    WHERE s.tenant_id = post.tenant_id
      AND s.deleted_at IS NULL
      AND s.status_code = 'active'
      AND (s.id = post.store_id OR (post.store_id IS NULL AND s.owner_member_id = tm.id))
    ORDER BY (s.id = post.store_id) DESC, s.id
    LIMIT 1
  ) st ON true
$$;
--> statement-breakpoint
ALTER FUNCTION public.post_seller_card(uuid, smallint) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.post_seller_card(uuid, smallint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.post_seller_card(uuid, smallint) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- post_engagement_counts
-- ============================================================================

-- The seller-facing counters: the post's author or tenant staff only; anyone
-- else gets no row. Contacts count the call/whatsapp/sms reveals (0009 lead
-- channels), saves count saved_posts rows.
CREATE OR REPLACE FUNCTION public.post_engagement_counts(p_post_id uuid)
RETURNS TABLE (views integer, calls integer, whatsapp integer, sms integer, saves integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    p.view_count,
    (SELECT count(*)::integer FROM public.lead_events le
     WHERE le.tenant_id = p.tenant_id AND le.post_id = p.id AND le.channel_code = 'call_click'),
    (SELECT count(*)::integer FROM public.lead_events le
     WHERE le.tenant_id = p.tenant_id AND le.post_id = p.id AND le.channel_code = 'whatsapp_click'),
    (SELECT count(*)::integer FROM public.lead_events le
     WHERE le.tenant_id = p.tenant_id AND le.post_id = p.id AND le.channel_code = 'sms_click'),
    (SELECT count(*)::integer FROM public.saved_posts sv
     WHERE sv.tenant_id = p.tenant_id AND sv.post_id = p.id)
  FROM public.posts p
  WHERE p.id = p_post_id
    AND p.tenant_id = public.current_tenant_id()
    AND (p.author_member_id = public.current_member_id() OR public.app_is_staff())
$$;
--> statement-breakpoint
ALTER FUNCTION public.post_engagement_counts(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.post_engagement_counts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.post_engagement_counts(uuid) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- report_post
-- ============================================================================

-- Files the caller's report on a public post (one open report per reporter
-- per post, 0010's unique index: a repeat returns the open one) and counts
-- the DISTINCT open reporters. At auto_hide_report_threshold (tenant
-- override, else platform; 0 = off) a live post goes to pending — the
-- system's live → pending edge of post-state-machine.ts — in this same
-- transaction as its moderation_actions row (CLAUDE.md rule 13), its queue
-- item and its post.auto_hidden outbox event. The post row is locked first,
-- so two last reports can't both miss or both cross the threshold.
--
-- SQLSTATEs: no_data_found = no such public post here; AE201 = the caller's
-- own post; insufficient_privilege = no member context.
CREATE OR REPLACE FUNCTION public.report_post(p_post_id uuid, p_reason_code text, p_details text)
RETURNS TABLE (report_id uuid, created boolean, reporter_count integer, auto_hidden boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_post record;
  v_report uuid;
  v_created boolean := false;
  v_count integer;
  v_threshold integer;
  v_hidden boolean := false;
BEGIN
  IF v_tenant IS NULL OR v_member IS NULL THEN
    RAISE EXCEPTION 'report_post: a member context is required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.id, p.author_member_id, p.status_code INTO v_post
  FROM public.posts p
  WHERE p.id = p_post_id
    AND p.tenant_id = v_tenant
    AND p.status_code IN ('live', 'sold')
    AND NOT p.hidden_by_owner
    AND p.deleted_at IS NULL
    AND p.scrubbed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_post: no public post % here', p_post_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_post.author_member_id = v_member THEN
    RAISE EXCEPTION 'report_post: own post' USING ERRCODE = 'AE201';
  END IF;

  INSERT INTO public.reports (tenant_id, reporter_member_id, post_id, reason_code, details)
  VALUES (v_tenant, v_member, p_post_id, p_reason_code, nullif(btrim(p_details), ''))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_report;
  v_created := v_report IS NOT NULL;
  IF NOT v_created THEN
    SELECT r.id INTO v_report FROM public.reports r
    WHERE r.tenant_id = v_tenant AND r.reporter_member_id = v_member AND r.post_id = p_post_id
      AND r.status_code IN ('open', 'in_review');
  END IF;

  SELECT count(DISTINCT r.reporter_member_id)::integer INTO v_count
  FROM public.reports r
  WHERE r.tenant_id = v_tenant AND r.post_id = p_post_id AND r.status_code IN ('open', 'in_review');

  SELECT coalesce((ts.setting_overrides ->> 'auto_hide_report_threshold')::integer,
                  (ps.value #>> '{}')::integer)
    INTO v_threshold
  FROM public.platform_settings ps
  LEFT JOIN public.tenant_settings ts ON ts.tenant_id = v_tenant
  WHERE ps.key = 'auto_hide_report_threshold';
  IF v_threshold IS NULL THEN
    RAISE EXCEPTION 'platform setting auto_hide_report_threshold is missing';
  END IF;

  IF v_created AND v_threshold > 0 AND v_count >= v_threshold AND v_post.status_code = 'live' THEN
    UPDATE public.posts SET status_code = 'pending' WHERE id = p_post_id;
    INSERT INTO public.moderation_actions
      (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
    SELECT v_tenant, p_post_id, NULL, 'auto_hidden', 'community_reports',
           format('%s distinct reporters (threshold %s)', v_count, v_threshold),
           coalesce(jsonb_agg(r.id ORDER BY r.id), '[]'::jsonb)
    FROM public.reports r
    WHERE r.tenant_id = v_tenant AND r.post_id = p_post_id AND r.status_code IN ('open', 'in_review');
    -- One open item per post: a report joins an existing item's reasons.
    INSERT INTO public.moderation_queue_items (tenant_id, post_id, author_member_id, source_code, reasons)
    VALUES (v_tenant, p_post_id, v_post.author_member_id, 'report', ARRAY['reported'])
    ON CONFLICT (post_id) WHERE status_code = 'open'
    DO UPDATE SET reasons = ARRAY(
      SELECT DISTINCT unnest(public.moderation_queue_items.reasons || EXCLUDED.reasons) ORDER BY 1
    );
    INSERT INTO public.outbox_events (aggregate_table, aggregate_id, event_type, payload)
    VALUES ('posts', p_post_id, 'post.auto_hidden', jsonb_build_object(
      'tenantId', v_tenant, 'from', 'live', 'to', 'pending',
      'reason', 'community_reports', 'reporters', v_count, 'threshold', v_threshold));
    v_hidden := true;
  END IF;

  RETURN QUERY SELECT v_report, v_created, v_count, v_hidden;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.report_post(uuid, text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.report_post(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.report_post(uuid, text, text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('view_dedupe_hours', '24', 'integer', 'hours', 1, 720, 'platform',
   'A post view counts once per viewer (user, else device) per this many hours.'),
  ('post_similar_max', '8', 'integer', 'count', 0, 30, 'tenant_admin',
   'Most similar posts (same category, nearby) under a post''s detail; 0 = none.'),
  ('post_similar_radius_km', '5', 'decimal', 'km', 0.5, 50, 'tenant_admin',
   'How far from the post to look for similar posts.'),
  ('contact_reveals_per_user_per_day', '30', 'integer', 'count', 1, 1000, 'platform',
   'Contact reveals (call/WhatsApp/SMS) one viewer may make per rolling 24 hours: stops number harvesting.'),
  ('require_login_for_contact', 'false', 'boolean', NULL, NULL, NULL, 'tenant_admin',
   'When true, a guest must sign in (OTP) before a seller''s contact is revealed.'),
  ('share_code_length', '8', 'integer', 'characters', 6, 16, 'platform',
   'Length of a post''s share code in /s/:code links.'),
  ('report_details_max_length', '500', 'integer', 'characters', 50, 2000, 'platform',
   'Longest free text a report may carry.'),
  ('reports_per_user_per_day', '20', 'integer', 'count', 1, 500, 'platform',
   'Reports one member may file per rolling 24 hours.');

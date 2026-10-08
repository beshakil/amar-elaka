-- 0051_seller_analytics
--
-- Seller analytics (ADR 055): "people found you, and this many contacted you".
--
--   analytics_daily        NEW, TENANT-SCOPED. One row per post or store per
--                          local day (Asia/Dhaka, the platform schedule zone):
--                          metrics jsonb of whole numbers — views,
--                          unique_viewers, contacts_<channel>,
--                          unique_contacters, saves, share_opens,
--                          search_appearances, map_taps. Written by the nightly
--                          rollup-analytics job only (system role); today's
--                          numbers come live from Redis, never from here.
--                          subject_scrubbed rows are excluded everywhere.
--   posts                  + posts_scrub_analytics: a privacy scrub flags the
--                          post's analytics rows, as scrub_post does for
--                          lead_events / lead_daily_stats (0027).
--   seller_scope_posts()   THE "whose numbers may I see" rule: a store's posts
--                          for its owner and accepted managers (current
--                          tenant), or my own posts in every tenant. Never a
--                          scrubbed post.
--   seller_daily_metrics() analytics_daily rows for that scope (+ the store's
--                          own row), never scrubbed ones.
--   seller_top_queries()   the searches that led to clicks on those posts,
--                          only queries enough distinct people made
--                          (analytics_query_min_searchers: a lone query could
--                          be personal).
--   analytics_rollup_leads()  the nightly lead rollup: one local day of
--                          lead_events into lead_daily_stats (§8.9 — the
--                          rollup the table was made for in 0009 and nothing
--                          ran), returning the counts for analytics_daily. The
--                          only place analytics reads lead_events.
--   scheduled_jobs         + rollup-analytics.
--   settings               analytics_periods_days, analytics_top_posts,
--                          analytics_top_queries, analytics_query_min_searchers,
--                          analytics_counter_retention_days,
--                          analytics_unique_retention_days,
--                          analytics_rollup_days_back.
--
-- No column is dropped or renamed.
-- Seeds: settings and the job here; demo history from the dev seed.
-- Tests: apps/api/test/analytics.db-spec.ts, analytics.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ---- 1. analytics_daily -------------------------------------------------------

CREATE TABLE public.analytics_daily (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT public.current_tenant_id(),
  entity_type       text        NOT NULL,
  entity_id         uuid        NOT NULL,
  stat_date         date        NOT NULL,
  metrics           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  subject_scrubbed  boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_pk PRIMARY KEY (id),
  CONSTRAINT analytics_daily_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT analytics_daily_entity_type_ck CHECK (entity_type IN ('post', 'store')),
  CONSTRAINT analytics_daily_metrics_ck CHECK (jsonb_typeof(metrics) = 'object')
);
--> statement-breakpoint
-- The rollup's upsert key; also a tenant's range reads.
CREATE UNIQUE INDEX analytics_daily_entity_day_uq
  ON public.analytics_daily (tenant_id, entity_type, entity_id, stat_date);
--> statement-breakpoint
-- "My posts" in every tenant: by entity, then the period.
CREATE INDEX analytics_daily_entity_id_day_idx ON public.analytics_daily (entity_id, stat_date)
  WHERE NOT subject_scrubbed;
--> statement-breakpoint
CREATE TRIGGER analytics_daily_set_updated_at BEFORE UPDATE ON public.analytics_daily
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.analytics_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.analytics_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Staff of the tenant read (moderation, partner reports later); never scrubbed rows.
CREATE POLICY analytics_daily_staff_read ON public.analytics_daily
  FOR SELECT
  USING (
    tenant_id = (SELECT public.current_tenant_id())
    AND (SELECT public.app_is_staff())
    AND NOT subject_scrubbed
  );
--> statement-breakpoint
-- The nightly rollup writes (every tenant, the system role).
CREATE POLICY analytics_daily_system ON public.analytics_daily
  FOR ALL
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY analytics_daily_platform_admin ON public.analytics_daily
  FOR ALL
  USING ((SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.analytics_daily TO ae_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.analytics_daily TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lead_daily_stats TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.lead_events, public.search_queries TO ae_rls_bypass;
--> statement-breakpoint

-- ---- 2. A scrub reaches the analytics ------------------------------------------

CREATE OR REPLACE FUNCTION public.posts_scrub_analytics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.analytics_daily
  SET subject_scrubbed = true
  WHERE tenant_id = NEW.tenant_id AND entity_type = 'post' AND entity_id = NEW.id AND NOT subject_scrubbed;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.posts_scrub_analytics() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER posts_scrub_analytics
  AFTER UPDATE OF scrubbed_at ON public.posts
  FOR EACH ROW
  WHEN (OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL)
  EXECUTE FUNCTION public.posts_scrub_analytics();
--> statement-breakpoint

-- ---- 3. Whose numbers may I see --------------------------------------------------

-- p_store_id set: that store's posts (any status but scrubbed, deleted ones
-- too — their history is the store's) for its owner and accepted managers in
-- the current tenant; otherwise AE250. p_store_id null: the caller's own
-- posts in every tenant (current_user_id()).
CREATE OR REPLACE FUNCTION public.seller_scope_posts(p_store_id uuid)
RETURNS TABLE (
  post_id uuid,
  tenant_id uuid,
  store_id uuid,
  author_member_id uuid,
  title text,
  status_code text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_member uuid := public.current_member_id();
  v_user uuid := public.current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'seller_scope_posts: no caller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_store_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.stores s
      WHERE s.id = p_store_id AND s.tenant_id = v_tenant AND s.deleted_at IS NULL
        AND (s.owner_member_id = v_member OR EXISTS (
          SELECT 1 FROM public.store_members sm
          WHERE sm.tenant_id = v_tenant AND sm.store_id = s.id AND sm.member_id = v_member
            AND sm.role_code = 'manager' AND sm.accepted_at IS NOT NULL))
    ) THEN
      RAISE EXCEPTION 'seller_scope_posts: not the owner or a manager of %', p_store_id USING ERRCODE = 'AE250';
    END IF;
    RETURN QUERY
      SELECT p.id, p.tenant_id, p.store_id, p.author_member_id, p.title, p.status_code, p.created_at
      FROM public.posts p
      WHERE p.tenant_id = v_tenant AND p.store_id = p_store_id AND p.scrubbed_at IS NULL;
  ELSE
    RETURN QUERY
      SELECT p.id, p.tenant_id, p.store_id, p.author_member_id, p.title, p.status_code, p.created_at
      FROM public.posts p
      JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id AND tm.id = p.author_member_id
      WHERE tm.user_id = v_user AND p.scrubbed_at IS NULL;
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.seller_scope_posts(uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.seller_scope_posts(uuid) TO ae_app;
--> statement-breakpoint

-- The scope's daily rows (and the store's own, for a store), between two local days inclusive.
CREATE OR REPLACE FUNCTION public.seller_daily_metrics(p_store_id uuid, p_from date, p_to date)
RETURNS TABLE (entity_type text, entity_id uuid, stat_date date, metrics jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.entity_type, a.entity_id, a.stat_date, a.metrics
  FROM public.seller_scope_posts(p_store_id) sp
  JOIN public.analytics_daily a
    ON a.tenant_id = sp.tenant_id AND a.entity_type = 'post' AND a.entity_id = sp.post_id
  WHERE a.stat_date BETWEEN p_from AND p_to AND NOT a.subject_scrubbed
  UNION ALL
  SELECT a.entity_type, a.entity_id, a.stat_date, a.metrics
  FROM public.analytics_daily a
  WHERE p_store_id IS NOT NULL
    AND a.tenant_id = public.current_tenant_id() AND a.entity_type = 'store' AND a.entity_id = p_store_id
    AND a.stat_date BETWEEN p_from AND p_to AND NOT a.subject_scrubbed
$$;
--> statement-breakpoint
ALTER FUNCTION public.seller_daily_metrics(uuid, date, date) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.seller_daily_metrics(uuid, date, date) TO ae_app;
--> statement-breakpoint

-- The searches whose results led to a click on the scope's posts.
CREATE OR REPLACE FUNCTION public.seller_top_queries(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_min_searchers integer,
  p_limit integer
)
RETURNS TABLE (q_normalized text, searchers bigint, clicks bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT q.q_normalized, count(DISTINCT q.searcher_hash), count(*)
  FROM public.seller_scope_posts(p_store_id) sp
  JOIN public.search_queries q ON q.clicked_post_id = sp.post_id AND q.tenant_id = sp.tenant_id
  WHERE q.created_at >= p_from AND q.created_at < p_to AND q.q_normalized <> ''
  GROUP BY q.q_normalized
  HAVING count(DISTINCT q.searcher_hash) >= greatest(p_min_searchers, 1)
  ORDER BY count(DISTINCT q.searcher_hash) DESC, count(*) DESC, q.q_normalized
  LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
ALTER FUNCTION public.seller_top_queries(uuid, timestamptz, timestamptz, integer, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.seller_top_queries(uuid, timestamptz, timestamptz, integer, integer) TO ae_app;
--> statement-breakpoint

-- ---- 4. The nightly lead rollup ---------------------------------------------------

-- One local day (p_day in p_tz) of lead_events into lead_daily_stats, every
-- tenant, idempotently (the counts are replaced, not added). A lead on a post
-- is the post's (its store's numbers add its posts up); a store-only lead is
-- the store's; a place lead the place's. Returns what it wrote. System only.
CREATE OR REPLACE FUNCTION public.analytics_rollup_leads(p_day date, p_tz text)
RETURNS TABLE (
  tenant_id uuid,
  post_id uuid,
  store_id uuid,
  place_id uuid,
  channel_code text,
  event_count integer,
  unique_actor_count integer,
  subject_scrubbed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_from timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_to timestamptz := (p_day + 1)::timestamp AT TIME ZONE p_tz;
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'analytics_rollup_leads: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH day AS (
    SELECT le.tenant_id,
           le.post_id,
           CASE WHEN le.post_id IS NULL THEN le.store_id END AS store_id,
           CASE WHEN le.post_id IS NULL AND le.store_id IS NULL THEN le.place_id END AS place_id,
           le.channel_code,
           count(*)::integer AS event_count,
           count(DISTINCT coalesce(le.actor_member_id::text, le.anon_session_hash))::integer AS unique_actor_count,
           bool_or(le.subject_scrubbed) AS subject_scrubbed
    FROM public.lead_events le
    WHERE le.occurred_at >= v_from AND le.occurred_at < v_to
      AND num_nonnulls(le.post_id, le.store_id, le.place_id) >= 1
    GROUP BY 1, 2, 3, 4, 5
  ),
  written AS (
    INSERT INTO public.lead_daily_stats AS ld
      (tenant_id, stat_date, post_id, store_id, place_id, channel_code, event_count,
       unique_actor_count, subject_scrubbed)
    SELECT d.tenant_id, p_day, d.post_id, d.store_id, d.place_id, d.channel_code, d.event_count,
           d.unique_actor_count, d.subject_scrubbed
    FROM day d
    ON CONFLICT (tenant_id, stat_date, post_id, store_id, place_id, channel_code)
    DO UPDATE SET event_count = EXCLUDED.event_count,
                  unique_actor_count = EXCLUDED.unique_actor_count,
                  subject_scrubbed = EXCLUDED.subject_scrubbed
    RETURNING ld.tenant_id, ld.post_id, ld.store_id, ld.place_id, ld.channel_code, ld.event_count,
              ld.unique_actor_count, ld.subject_scrubbed
  )
  SELECT * FROM written;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.analytics_rollup_leads(date, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.analytics_rollup_leads(date, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.analytics_rollup_leads(date, text) TO ae_app;
--> statement-breakpoint

-- ---- 5. The job and settings ------------------------------------------------------

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('rollup-analytics', 'enum.scheduled_jobs.rollup-analytics', 130);
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('analytics_periods_days', '[7, 30, 90]', 'nullable_integer_array', 'days', NULL, NULL, 'none',
   'The periods a seller can choose on the analytics screen (?period=7d …); the first is the default.'),
  ('analytics_top_posts', '5', 'integer', 'posts', 1, 50, 'platform',
   'How many top posts the analytics screen lists.'),
  ('analytics_top_queries', '5', 'integer', 'queries', 0, 50, 'platform',
   'How many of the searches that led to a seller the analytics screen lists.'),
  ('analytics_query_min_searchers', '2', 'integer', 'people', 1, 100, 'platform',
   'A search query is shown to a seller only once this many different people searched it (a lone query could be personal).'),
  ('analytics_counter_retention_days', '7', 'integer', 'days', 2, 60, 'none',
   'How long a day''s live Redis counters are kept: the nightly rollup has this long to catch up after an outage.'),
  ('analytics_unique_retention_days', '182', 'integer', 'days', 14, 400, 'none',
   'How long the per-day unique viewer/contacter sketches stay in Redis: twice the longest period, so "unique viewers" and its previous-period trend are exact across days.'),
  ('analytics_rollup_days_back', '7', 'integer', 'days', 1, 60, 'none',
   'How many finished days the nightly rollup revisits each run (idempotent), so a missed night is filled in.');

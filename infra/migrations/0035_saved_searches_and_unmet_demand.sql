-- 0035_saved_searches_and_unmet_demand
--
-- Saved searches with alerts (Q25, §8.11, §13.29; ADR 041) and the unmet
-- demand view built on them and on the search log (ADR 040).
--
--   saved_searches            + notify_day / notify_count: the per-search
--                             daily notification cap (saved_search_notify_per_day),
--                             counted per Asia/Dhaka day.
--   saved_search_matches      GLOBAL, owner-read: the posts a saved search
--                             matched. Unseen rows are the "new results" list
--                             and its badge count; notified_at groups them into
--                             one notification per search. A scrubbed post's
--                             matches are deleted.
--   saved_search_watermarks   TENANT-SCOPED, system-only: the last post of each
--                             tenant the matcher has looked at.
--   search_queries            + category_id, origin (rounded, only when the
--                             searcher shared a location): what unmet demand
--                             groups by.
--   unmet_demand              MATERIALIZED VIEW per tenant × category ×
--                             geo_area: active saved searches, and searches of
--                             the last unmet_demand_window_days that found
--                             fewer than unmet_demand_result_threshold results.
--                             A view can't have RLS, so nobody but its owner
--                             reads it: unmet_demand_for_tenant() serves the
--                             current tenant's rows to its admins, and
--                             refresh_unmet_demand() (system) refreshes it.
--
-- Seeds: settings, the saved_search_paused notification type and the three
-- scheduled jobs below; dev rows come from seed.ts.

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('saved_search_match_grace_seconds', '60', 'integer', 'seconds', 5, 3600, 'none',
   'A post is matched against saved searches once it has been live this long, so the search index has it.'),
  ('saved_search_daily_digest_hour', '9', 'integer', 'hour', 0, 23, 'none',
   'Asia/Dhaka hour from which daily saved-search digests go out.'),
  ('saved_search_new_results_max', '50', 'integer', 'count', 1, 200, 'none',
   'Most new results GET /saved-searches/:id/new-results returns at once.'),
  ('saved_search_name_max_length', '80', 'integer', 'chars', 1, 200, 'none',
   'Longest saved-search name.'),
  ('unmet_demand_result_threshold', '3', 'integer', 'count', 1, 1000, 'none',
   'A search that finds fewer results than this counts as unmet demand.'),
  ('unmet_demand_window_days', '30', 'integer', 'days', 1, 365, 'none',
   'How far back unmet demand counts searches.'),
  ('search_log_origin_decimals', '2', 'integer', 'decimals', 1, 4, 'none',
   'Decimal places the logged search origin is rounded to (2 ≈ 1 km), so the log never holds an exact location.');
--> statement-breakpoint

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('saved_search_paused', 'enum.notification_types.saved_search_paused', 85);
--> statement-breakpoint

-- Codes are the BullMQ job names (apps/api/src/queue/queue.types.ts).
INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('match-saved-searches', 'enum.scheduled_jobs.match-saved-searches', 70),
  ('pause-idle-saved-searches', 'enum.scheduled_jobs.pause-idle-saved-searches', 80),
  ('refresh-unmet-demand', 'enum.scheduled_jobs.refresh-unmet-demand', 90);
--> statement-breakpoint

-- ============================================================================
-- saved_searches: the daily notification cap
-- ============================================================================

ALTER TABLE public.saved_searches ADD COLUMN notify_day date;
--> statement-breakpoint
ALTER TABLE public.saved_searches ADD COLUMN notify_count smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.saved_searches ADD CONSTRAINT saved_searches_notify_count_ck CHECK (notify_count >= 0);
--> statement-breakpoint
-- Candidate searches of the matcher: active, not paused, by place.
CREATE INDEX saved_searches_active_center_gix ON public.saved_searches USING gist (center)
  WHERE is_active AND paused_at IS NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- ============================================================================
-- saved_search_matches (GLOBAL)
-- ============================================================================

CREATE TABLE public.saved_search_matches (
  id                uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  saved_search_id   uuid        NOT NULL,
  -- The search's owner, denormalised for RLS and the badge count.
  user_id           uuid        NOT NULL,
  post_id           uuid        NOT NULL,
  -- Where the post lives (cards are read in the owner's tenant).
  post_tenant_id    uuid        NOT NULL,
  notified_at       timestamptz,
  seen_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_search_matches_pk PRIMARY KEY (id),
  CONSTRAINT saved_search_matches_saved_search_id_fk FOREIGN KEY (saved_search_id)
    REFERENCES public.saved_searches (id) ON DELETE CASCADE,
  CONSTRAINT saved_search_matches_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT saved_search_matches_post_tenant_id_post_id_fk FOREIGN KEY (post_tenant_id, post_id)
    REFERENCES public.posts (tenant_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX saved_search_matches_search_post_uq ON public.saved_search_matches (saved_search_id, post_id);
--> statement-breakpoint
-- The badge and the new-results list: unseen, newest first.
CREATE INDEX saved_search_matches_unseen_idx ON public.saved_search_matches (saved_search_id, id DESC)
  WHERE seen_at IS NULL;
--> statement-breakpoint
-- The notifier: matches not yet notified.
CREATE INDEX saved_search_matches_unnotified_idx ON public.saved_search_matches (saved_search_id)
  WHERE notified_at IS NULL AND seen_at IS NULL;
--> statement-breakpoint
CREATE INDEX saved_search_matches_user_id_idx ON public.saved_search_matches (user_id);
--> statement-breakpoint
CREATE INDEX saved_search_matches_post_idx ON public.saved_search_matches (post_tenant_id, post_id);
--> statement-breakpoint
CREATE TRIGGER saved_search_matches_set_updated_at BEFORE UPDATE ON public.saved_search_matches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.saved_search_matches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_search_matches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- G-OWNER, like saved_searches: the owner reads their matches and marks them seen.
CREATE POLICY saved_search_matches_owner_read ON public.saved_search_matches
  FOR SELECT
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()));
--> statement-breakpoint
CREATE POLICY saved_search_matches_owner_update ON public.saved_search_matches
  FOR UPDATE
  USING (user_id = (SELECT public.current_user_id()) AND (SELECT public.app_is_active_user()))
  WITH CHECK (user_id = (SELECT public.current_user_id()));
--> statement-breakpoint
-- The matcher writes (system).
CREATE POLICY saved_search_matches_system ON public.saved_search_matches
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY saved_search_matches_platform_admin ON public.saved_search_matches
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_search_matches TO ae_app;
--> statement-breakpoint
-- The owner may only flip seen_at.
REVOKE UPDATE ON public.saved_search_matches FROM ae_app;
--> statement-breakpoint
GRANT UPDATE (seen_at, notified_at, updated_at) ON public.saved_search_matches TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- saved_search_watermarks (TENANT-SCOPED)
-- ============================================================================

CREATE TABLE public.saved_search_watermarks (
  tenant_id          uuid        NOT NULL,
  last_published_at  timestamptz NOT NULL,
  last_post_id       uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_search_watermarks_pk PRIMARY KEY (tenant_id),
  CONSTRAINT saved_search_watermarks_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER saved_search_watermarks_set_updated_at BEFORE UPDATE ON public.saved_search_watermarks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.saved_search_watermarks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_search_watermarks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY saved_search_watermarks_system ON public.saved_search_watermarks
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY saved_search_watermarks_platform_admin ON public.saved_search_watermarks
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.saved_search_watermarks TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- A scrubbed post leaves saved-search results too
-- ============================================================================

-- Same shape as search_queries_forget_scrubbed_post (0034); runs as the
-- scrub's own definer context, so SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.saved_search_matches_forget_scrubbed_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.saved_search_matches WHERE post_tenant_id = NEW.tenant_id AND post_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.saved_search_matches_forget_scrubbed_post() OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.saved_search_matches TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER posts_scrub_forget_saved_search_matches
  AFTER UPDATE OF scrubbed_at ON public.posts
  FOR EACH ROW
  WHEN (OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL)
  EXECUTE FUNCTION public.saved_search_matches_forget_scrubbed_post();
--> statement-breakpoint

-- A post that stops being live (sold, removed, hidden, deleted) leaves the
-- unseen "new results" too, so the badge never counts a listing that can't
-- be opened. Seen rows stay (they are history, and nobody is shown them).
CREATE OR REPLACE FUNCTION public.saved_search_matches_forget_unlive_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.saved_search_matches
  WHERE post_tenant_id = NEW.tenant_id AND post_id = NEW.id AND seen_at IS NULL;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.saved_search_matches_forget_unlive_post() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER posts_unlive_forget_saved_search_matches
  AFTER UPDATE OF status_code, deleted_at, hidden_by_owner ON public.posts
  FOR EACH ROW
  WHEN (OLD.status_code = 'live' AND OLD.deleted_at IS NULL AND NOT OLD.hidden_by_owner
        AND (NEW.status_code <> 'live' OR NEW.deleted_at IS NOT NULL OR NEW.hidden_by_owner))
  EXECUTE FUNCTION public.saved_search_matches_forget_unlive_post();
--> statement-breakpoint

-- ============================================================================
-- search_queries: category and (rounded) origin
-- ============================================================================

ALTER TABLE public.search_queries ADD COLUMN category_id uuid;
--> statement-breakpoint
ALTER TABLE public.search_queries ADD CONSTRAINT search_queries_category_id_fk FOREIGN KEY (category_id)
  REFERENCES public.categories (id) ON DELETE SET NULL;
--> statement-breakpoint
-- Rounded to search_log_origin_decimals by the API; NULL when the searcher
-- shared no location (the tenant's centre would only skew the areas).
ALTER TABLE public.search_queries ADD COLUMN origin geography(Point, 4326);
--> statement-breakpoint
CREATE INDEX search_queries_origin_gix ON public.search_queries USING gist (origin);
--> statement-breakpoint
CREATE INDEX search_queries_category_id_idx ON public.search_queries (category_id)
  WHERE category_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================================
-- unmet_demand
-- ============================================================================

-- The view's query runs at every refresh, so the settings it reads apply
-- from the next refresh on. A saved search belongs to the tenant owning its
-- centre (resolve_owning_tenant, 0023); a search query to the tenant it was
-- made in. geo_area: the finest area containing the point (NULL without one).
CREATE MATERIALIZED VIEW public.unmet_demand AS
WITH knobs AS (
  SELECT
    (SELECT (ps.value #>> '{}')::integer FROM public.platform_settings ps
     WHERE ps.key = 'unmet_demand_result_threshold') AS threshold,
    (SELECT (ps.value #>> '{}')::integer FROM public.platform_settings ps
     WHERE ps.key = 'unmet_demand_window_days') AS window_days
),
demand AS (
  SELECT owner.tenant_id, s.category_id, area.id AS geo_area_id,
         1 AS saved_search, 0 AS weak_search
  FROM public.saved_searches s
  CROSS JOIN LATERAL (
    SELECT o.tenant_id FROM public.resolve_owning_tenant(s.center, NULL) o LIMIT 1
  ) owner
  LEFT JOIN LATERAL (
    SELECT g.id FROM public.geo_areas g
    WHERE g.boundary IS NOT NULL AND st_covers(g.boundary, s.center)
    ORDER BY g.adm_level DESC LIMIT 1
  ) area ON true
  WHERE s.is_active AND s.paused_at IS NULL AND s.deleted_at IS NULL
    AND owner.tenant_id IS NOT NULL
  UNION ALL
  SELECT q.tenant_id, q.category_id, area.id, 0, 1
  FROM public.search_queries q
  CROSS JOIN knobs
  LEFT JOIN LATERAL (
    SELECT g.id FROM public.geo_areas g
    WHERE q.origin IS NOT NULL AND g.boundary IS NOT NULL AND st_covers(g.boundary, q.origin)
    ORDER BY g.adm_level DESC LIMIT 1
  ) area ON true
  WHERE q.created_at >= now() - make_interval(days => knobs.window_days)
    AND q.result_count < knobs.threshold
)
SELECT tenant_id, category_id, geo_area_id,
       sum(saved_search)::integer AS active_saved_searches,
       sum(weak_search)::integer AS weak_searches,
       now() AS refreshed_at
FROM demand
GROUP BY tenant_id, category_id, geo_area_id;
--> statement-breakpoint
-- REFRESH … CONCURRENTLY needs a unique index over every row.
CREATE UNIQUE INDEX unmet_demand_uq ON public.unmet_demand (tenant_id, category_id, geo_area_id)
  NULLS NOT DISTINCT;
--> statement-breakpoint
-- No RLS on a view: nobody reads it directly, only through the functions below.
REVOKE ALL ON public.unmet_demand FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.saved_searches, public.search_queries, public.geo_areas, public.categories,
  public.tenants, public.tenant_settings, public.platform_settings TO ae_rls_bypass;
--> statement-breakpoint
ALTER MATERIALIZED VIEW public.unmet_demand OWNER TO ae_rls_bypass;
--> statement-breakpoint

-- The current tenant's unmet demand, for its admins and platform staff.
CREATE OR REPLACE FUNCTION public.unmet_demand_for_tenant()
RETURNS TABLE (
  category_id uuid,
  category_slug text,
  category_name_bn text,
  category_name_en text,
  geo_area_id uuid,
  geo_area_name_bn text,
  geo_area_name_en text,
  active_saved_searches integer,
  weak_searches integer,
  refreshed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.app_is_tenant_admin() OR public.app_is_platform()) THEN
    RAISE EXCEPTION 'unmet_demand_for_tenant: tenant admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT u.category_id, c.slug, c.name_bn, c.name_en,
           u.geo_area_id, g.name_bn, g.name_en,
           u.active_saved_searches, u.weak_searches, u.refreshed_at
    FROM public.unmet_demand u
    LEFT JOIN public.categories c ON c.id = u.category_id
    LEFT JOIN public.geo_areas g ON g.id = u.geo_area_id
    WHERE u.tenant_id = public.current_tenant_id()
    ORDER BY u.active_saved_searches + u.weak_searches DESC, c.slug NULLS LAST, g.name_en NULLS LAST;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.unmet_demand_for_tenant() OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.unmet_demand_for_tenant() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.unmet_demand_for_tenant() TO ae_app;
--> statement-breakpoint

-- The scheduled refresh (system only). CONCURRENTLY: readers never wait.
CREATE OR REPLACE FUNCTION public.refresh_unmet_demand()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'refresh_unmet_demand: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.unmet_demand;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.refresh_unmet_demand() OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.refresh_unmet_demand() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.refresh_unmet_demand() TO ae_app;

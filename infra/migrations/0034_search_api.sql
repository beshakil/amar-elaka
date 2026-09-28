-- 0034_search_api
--
-- The search API on top of the Month 1 index (ADR 040, schema.md §8.12):
--
--   search_queries            TENANT-SCOPED query log: normalized text only
--                             (never the raw query), a filters digest, the
--                             result count and the post the searcher opened.
--                             Feeds trending, synonym tuning (the zero-result
--                             report) and unmet-demand analytics.
--   record_search_click()     the one way a click is written: the searcher's
--                             own row, once, within the click window.
--   search_popular_queries()  top queries of the current tenant, counted in
--                             DISTINCT searchers so one person searching
--                             fifty times can't make a query trend. Aggregates
--                             only: no row, user or searcher leaves it.
--   scrub → search_queries    a scrubbed post is forgotten by the log too.
--   boost slot cap in search  the index's is_boosted now obeys the feed's
--                             boost_slots_per_category cap (feed_posts, 0030),
--                             so any boost change re-syncs the other boosted
--                             posts of its category; so does a change of the
--                             cap itself.
--   is_shippable in search    documents carry it (scope=country), so a
--                             category's shippable flag re-syncs it.
--
-- Seeds: settings below. Rows come from real searches (seed.ts has none).

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('trending_window_hours', '24', 'integer', 'hours', 1, 720, 'tenant_admin',
   'How far back GET /search/trending counts searches.'),
  ('search_trending_min_searchers', '3', 'integer', 'count', 1, 1000, 'tenant_admin',
   'Distinct searchers a query needs before it can trend or be suggested, so one person cannot make it trend.'),
  ('search_trending_limit', '10', 'integer', 'count', 1, 50, 'none',
   'Queries returned by GET /search/trending.'),
  ('search_list_cache_seconds', '300', 'integer', 'seconds', 0, 3600, 'none',
   'How long trending, popular-query and category-suggestion lists are cached per tenant (0 = no cache).'),
  ('search_popular_window_days', '30', 'integer', 'days', 1, 365, 'none',
   'How far back the popular queries offered by suggestions are counted.'),
  ('search_popular_pool_size', '500', 'integer', 'count', 10, 5000, 'none',
   'Popular queries kept per tenant for as-you-type matching.'),
  ('search_suggest_listings_max', '5', 'integer', 'count', 0, 20, 'none',
   'Listing titles returned per suggestion request.'),
  ('search_suggest_queries_max', '3', 'integer', 'count', 0, 20, 'none',
   'Popular queries returned per suggestion request.'),
  ('search_suggest_categories_max', '3', 'integer', 'count', 0, 20, 'none',
   'Categories returned per suggestion request.'),
  ('search_facet_fields_max', '4', 'integer', 'count', 0, 20, 'none',
   'Select-type custom fields of the chosen category returned as facets.'),
  ('search_price_bucket_count', '5', 'integer', 'count', 0, 12, 'none',
   'Price ranges returned as a facet (0 = none). Boundaries adapt to the prices in the results.'),
  ('search_landmarks_max', '3', 'integer', 'count', 0, 10, 'none',
   'Matching landmarks shown above the first page of a text search.'),
  ('search_click_window_minutes', '60', 'integer', 'minutes', 1, 1440, 'none',
   'How long after a search a click on one of its results is still recorded.'),
  ('search_zero_result_report_days', '7', 'integer', 'days', 1, 90, 'none',
   'Default look-back of the zero-result report (search:zero-results) used for synonym tuning.'),
  ('search_zero_result_report_limit', '50', 'integer', 'count', 1, 1000, 'none',
   'Default number of queries in the zero-result report.');
--> statement-breakpoint

-- ============================================================================
-- search_queries
-- ============================================================================

CREATE TABLE public.search_queries (
  id               uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT public.current_tenant_id(),
  -- Set only for a signed-in searcher; the account's deletion keeps the row, anonymous.
  user_id          uuid,
  -- HMAC of the searcher (user, install or ip+agent) and the UTC day: counts
  -- distinct searchers for trending without an identity, and changes daily
  -- so it can't follow an anonymous person across days.
  searcher_hash    text        NOT NULL,
  -- normalizeSearchText(q): NFC, zero-width marks removed, Bengali digits as
  -- ASCII, Latin lower-cased, whitespace collapsed. Never the raw query.
  q_normalized     text        NOT NULL,
  -- Digest of scope, type, category, custom filters and price range (not the location).
  filters_hash     text        NOT NULL,
  result_count     integer     NOT NULL,
  -- Cross-tenant (discovery crosses boundaries), so a plain FK on posts.id.
  clicked_post_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_queries_pk PRIMARY KEY (id),
  CONSTRAINT search_queries_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT search_queries_user_id_fk FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT search_queries_clicked_post_id_fk FOREIGN KEY (clicked_post_id)
    REFERENCES public.posts (id) ON DELETE SET NULL,
  CONSTRAINT search_queries_q_normalized_ck CHECK (char_length(q_normalized) BETWEEN 1 AND 200),
  CONSTRAINT search_queries_filters_hash_ck CHECK (filters_hash ~ '^[0-9a-f]{16}$'),
  CONSTRAINT search_queries_searcher_hash_ck CHECK (searcher_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT search_queries_result_count_ck CHECK (result_count >= 0)
);
--> statement-breakpoint
-- Trending / popular queries of a tenant; also the tenant_id index.
CREATE INDEX search_queries_tenant_created_idx ON public.search_queries (tenant_id, created_at DESC);
--> statement-breakpoint
-- The zero-result report (synonym tuning, unmet demand).
CREATE INDEX search_queries_zero_result_idx ON public.search_queries (created_at DESC)
  WHERE result_count = 0;
--> statement-breakpoint
CREATE INDEX search_queries_user_id_idx ON public.search_queries (user_id) WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX search_queries_clicked_post_id_idx ON public.search_queries (clicked_post_id)
  WHERE clicked_post_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER search_queries_set_updated_at BEFORE UPDATE ON public.search_queries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.search_queries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.search_queries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Anyone searching in this tenant logs their search: as themselves or
-- anonymously, never as someone else, and never with a click already set.
CREATE POLICY search_queries_insert_own ON public.search_queries
  FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT public.current_tenant_id())
    AND (user_id IS NULL OR user_id = (SELECT public.current_user_id()))
    AND clicked_post_id IS NULL
  );
--> statement-breakpoint
-- Tenant admins read their tenant's log (unmet-demand analytics); moderators
-- have no need for who searched what. The public only ever sees aggregates
-- (search_popular_queries).
CREATE POLICY search_queries_tenant_admin_read ON public.search_queries
  FOR SELECT
  USING (tenant_id = (SELECT public.current_tenant_id()) AND (SELECT public.app_is_tenant_admin()));
--> statement-breakpoint
CREATE POLICY search_queries_platform_read ON public.search_queries
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY search_queries_platform_admin ON public.search_queries
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT ON public.search_queries TO ae_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.search_queries TO ae_rls_bypass;
--> statement-breakpoint

-- ============================================================================
-- record_search_click
-- ============================================================================

-- The searcher's own search (same user, or an anonymous one), in the current
-- tenant, not yet clicked, within p_window_minutes (search_click_window_minutes,
-- passed by the API). The post must be public now: never a scrubbed,
-- deleted or unpublished one. Returns whether the click was recorded.
-- SECURITY DEFINER: the public may not update the log, only this.
CREATE OR REPLACE FUNCTION public.record_search_click(
  p_search_id uuid,
  p_post_id uuid,
  p_window_minutes integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_rows integer;
BEGIN
  IF p_search_id IS NULL OR p_post_id IS NULL OR p_window_minutes IS NULL OR p_window_minutes <= 0 THEN
    RAISE EXCEPTION 'record_search_click needs a search, a post and a positive window'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.search_queries q
  SET clicked_post_id = p_post_id
  WHERE q.id = p_search_id
    AND q.tenant_id = public.current_tenant_id()
    AND q.clicked_post_id IS NULL
    AND q.created_at > now() - make_interval(mins => p_window_minutes)
    AND (q.user_id IS NULL OR q.user_id = public.current_user_id())
    AND EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = p_post_id
        AND p.status_code IN ('live', 'sold')
        AND p.deleted_at IS NULL AND p.scrubbed_at IS NULL
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.record_search_click(uuid, uuid, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_search_click(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_search_click(uuid, uuid, integer) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- search_popular_queries
-- ============================================================================

-- Top queries of the current tenant since p_since that found something,
-- ranked by distinct searchers (then searches). A query needs
-- p_min_searchers distinct searchers (search_trending_min_searchers) to
-- appear at all. Serves both GET /search/trending and the suggestion pool.
-- SECURITY DEFINER: aggregates only, the rows stay staff-only.
CREATE OR REPLACE FUNCTION public.search_popular_queries(
  p_since timestamptz,
  p_min_searchers integer,
  p_limit integer
)
RETURNS TABLE (q_normalized text, searchers bigint, searches bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT q.q_normalized, count(DISTINCT q.searcher_hash) AS searchers, count(*) AS searches
  FROM public.search_queries q
  WHERE q.tenant_id = public.current_tenant_id()
    AND q.created_at >= p_since
    AND q.result_count > 0
  GROUP BY q.q_normalized
  HAVING count(DISTINCT q.searcher_hash) >= greatest(p_min_searchers, 1)
  ORDER BY searchers DESC, searches DESC, q.q_normalized
  LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
ALTER FUNCTION public.search_popular_queries(timestamptz, integer, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.search_popular_queries(timestamptz, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.search_popular_queries(timestamptz, integer, integer) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- A scrubbed post leaves the query log too
-- ============================================================================

-- scrub_post() (0027) runs as ae_rls_bypass; any other path that ever sets
-- scrubbed_at is covered as well, so this is SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.search_queries_forget_scrubbed_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.search_queries SET clicked_post_id = NULL WHERE clicked_post_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.search_queries_forget_scrubbed_post() OWNER TO ae_rls_bypass;
--> statement-breakpoint
CREATE TRIGGER posts_scrub_forget_search_clicks
  AFTER UPDATE OF scrubbed_at ON public.posts
  FOR EACH ROW
  WHEN (OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL)
  EXECUTE FUNCTION public.search_queries_forget_scrubbed_post();
--> statement-breakpoint

-- ============================================================================
-- Boost slot cap in search: fan-out
-- ============================================================================

-- Which boosts count is decided per (tenant, category) — the first
-- boost_slots_per_category by start — so a boost starting, ending or moving
-- can change whether ANOTHER post of its category counts as boosted. The
-- existing boosts_search_sync (0020) re-syncs the post itself; this adds a
-- resync of the category's other boosted posts (the relay resolves the
-- category from the post).
CREATE OR REPLACE FUNCTION public.search_resync_boost_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.post_id IS NOT NULL THEN
    PERFORM public.search_enqueue('search.resync', 'boosts', OLD.id,
      jsonb_build_object('scope', 'boost_post', 'tenant_id', OLD.tenant_id, 'post_id', OLD.post_id));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.post_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.post_id IS DISTINCT FROM OLD.post_id) THEN
    PERFORM public.search_enqueue('search.resync', 'boosts', NEW.id,
      jsonb_build_object('scope', 'boost_post', 'tenant_id', NEW.tenant_id, 'post_id', NEW.post_id));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER boosts_search_resync_category
  AFTER INSERT OR DELETE OR UPDATE OF status_code, starts_at, ends_at, post_id, boost_type_id ON public.boosts
  FOR EACH ROW EXECUTE FUNCTION public.search_resync_boost_category();
--> statement-breakpoint

-- The cap itself changing: every post with a boost (platform), or the
-- tenant's (override). aggregate_id: the tenant, or the nil uuid for the platform.
CREATE OR REPLACE FUNCTION public.search_resync_boost_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'platform_settings' THEN
    PERFORM public.search_enqueue('search.resync', 'platform_settings',
      '00000000-0000-0000-0000-000000000000'::uuid, jsonb_build_object('scope', 'boosted'));
  ELSE
    PERFORM public.search_enqueue('search.resync', 'tenant_settings', NEW.tenant_id,
      jsonb_build_object('scope', 'boosted', 'tenant_id', NEW.tenant_id));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_settings_search_boost_cap
  AFTER UPDATE OF value ON public.platform_settings
  FOR EACH ROW
  WHEN (NEW.key = 'boost_slots_per_category' AND NEW.value IS DISTINCT FROM OLD.value)
  EXECUTE FUNCTION public.search_resync_boost_cap();
--> statement-breakpoint
CREATE TRIGGER tenant_settings_search_boost_cap
  AFTER UPDATE OF setting_overrides ON public.tenant_settings
  FOR EACH ROW
  WHEN ((NEW.setting_overrides -> 'boost_slots_per_category')
        IS DISTINCT FROM (OLD.setting_overrides -> 'boost_slots_per_category'))
  EXECUTE FUNCTION public.search_resync_boost_cap();
--> statement-breakpoint

-- ============================================================================
-- is_shippable is now in documents (scope=country)
-- ============================================================================

CREATE TRIGGER categories_search_resync_shippable
  AFTER UPDATE OF is_shippable ON public.categories
  FOR EACH ROW
  WHEN (NEW.is_shippable IS DISTINCT FROM OLD.is_shippable)
  EXECUTE FUNCTION public.search_resync_category();

-- 0049_open_now_indexes_and_client_settings
--
-- Gaps left open by the month 2 review (docs/status/month-2-review.md §6–§9).
--
-- 1. open_now speed. is_open_at() looks a place's or store's hours up by
--    place_id / store_id alone, but every hours index starts with tenant_id,
--    so each call scanned all of place_hours (10k rows at pilot volume:
--    ~2.1 of its ~2.6 ms). Entity-first indexes make one call ~4x cheaper and
--    the map's open_now ~3.6x faster, with is_open_at still the only open/
--    closed implementation. The tenant-first indexes stay: owner screens list
--    one tenant's hours through RLS.
--
-- 2. One visibility rule (§6). "Listed" — shown in the feed, on the map, in
--    the heatmap and nearby discovery — was written out by hand in each
--    function, and the copies drifted (expiry). post_is_listed() is now the
--    rule; post_is_viewable() is the post page's (live or sold). Both are
--    IMMUTABLE single-expression SQL functions: the planner inlines them, so
--    the live-post partial indexes still match (checked with EXPLAIN on
--    feed_posts and map_features). discover_nearby now drops expired posts
--    too. The functions below are their current bodies (pg_get_functiondef)
--    with only the predicate changed; post_seller_card and report_post take
--    post_is_viewable.
--
-- 3. One area geometry (§6). nearest_tenants(), tenant_distance_m() and
--    tenant_covers_point() each spelled out "distance from a tenant's area"
--    (radius circle or polygon). tenant_area_distance_m() is now that
--    geometry and all three use it.
--
-- 4. Settings.
--    Retired:
--      map_style_fallback    let clients load a third-party style directly:
--                            a Barikoi style costs 4 calls per map load, never
--                            counted in geo_provider_calls, with the key in a
--                            client-visible URL (CLAUDE.md map rules). Without
--                            our tiles the map now says it is unavailable.
--      search_suggest_limit  read by nothing (the _categories/_queries/
--                            _listings_max settings cap suggestions).
--    New:
--      client_config_refresh_minutes  how old a phone's cached tenant config
--                            may get before it refreshes it (was 24 h in the app).
--      search_description_max_chars  how much of a description the search
--                            index keeps (was a constant in document-builder.ts).
--
-- No new table, so no new RLS policy or seed.
-- Tests: apps/api/test/db/post-visibility.db-spec.ts, hours.db-spec.ts,
-- location-system.db-spec.ts; the settings parity spec.

-- ---- 1. Hours, by entity ---------------------------------------------------

CREATE INDEX place_hours_place_day_idx ON public.place_hours (place_id, iso_day_of_week);
--> statement-breakpoint
CREATE INDEX store_hours_store_day_idx ON public.store_hours (store_id, iso_day_of_week);
--> statement-breakpoint
CREATE INDEX hours_exceptions_place_on_date_idx ON public.hours_exceptions (place_id, on_date)
  WHERE place_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX hours_exceptions_store_on_date_idx ON public.hours_exceptions (store_id, on_date)
  WHERE store_id IS NOT NULL;
--> statement-breakpoint

-- ---- 2. Visibility ----------------------------------------------------------

-- THE rule for "listed": a live post, not deleted, not scrubbed (a privacy
-- scrub can leave the status alone and empty the content), not hidden by
-- its owner, not past expires_at (the expiry job flips the status up to its
-- schedule interval later; until then this already hides it). p_at is the
-- caller's clock (feed_posts uses its cursor's as_of).
CREATE FUNCTION public.post_is_listed(
  p_status text,
  p_deleted_at timestamptz,
  p_scrubbed_at timestamptz,
  p_hidden boolean,
  p_expires_at timestamptz,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN p_status = 'live' AND p_deleted_at IS NULL AND p_scrubbed_at IS NULL AND NOT p_hidden
       AND (p_expires_at IS NULL OR p_expires_at > p_at);
--> statement-breakpoint

-- THE rule for a post page anyone may open: live or sold (shown marked
-- sold), not deleted, not hidden. A scrubbed one still opens, in its
-- scrubbed shape. apps/api/src/posts/post-visibility.ts applies the same rule
-- to a loaded row; post-visibility.db-spec.ts proves they agree.
CREATE FUNCTION public.post_is_viewable(p_status text, p_deleted_at timestamptz, p_hidden boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN p_status IN ('live', 'sold') AND p_deleted_at IS NULL AND NOT p_hidden;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.post_is_listed(text, timestamptz, timestamptz, boolean, timestamptz, timestamptz),
                          public.post_is_viewable(text, timestamptz, boolean)
  TO ae_app, ae_rls_bypass;
--> statement-breakpoint

-- ---- 3. Tenant area geometry -----------------------------------------------

-- Metres from a tenant's area to a point, 0 inside or on its edge: the
-- radius circle (radius mode) or the polygon. NULL for a polygon-mode tenant
-- without a boundary (it has no area, only a centre).
CREATE FUNCTION public.tenant_area_distance_m(
  p_mode text,
  p_center geography,
  p_radius_km numeric,
  p_boundary geography,
  p_point geography
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN CASE
  WHEN p_mode = 'radius' THEN greatest(0, st_distance(p_center, p_point) - p_radius_km * 1000)
  WHEN p_boundary IS NOT NULL THEN st_distance(p_boundary, p_point)
END;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.tenant_area_distance_m(text, geography, numeric, geography, geography)
  TO ae_app, ae_rls_bypass;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.nearest_tenants(p_point geography, p_max_distance_m double precision, p_limit integer DEFAULT 1)
RETURNS TABLE (tenant_id uuid, inside boolean, distance_m double precision)
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.distance_m = 0, c.distance_m
  FROM (
    SELECT t.id, st_distance(t.map_center, p_point) AS center_m,
           coalesce(
             public.tenant_area_distance_m(t.boundary_mode, t.map_center, t.service_radius_km, ga.boundary, p_point),
             -- No area, only a centre: measured to it, never "inside".
             greatest(st_distance(t.map_center, p_point), 1e-9)) AS distance_m
    FROM public.tenants t
    LEFT JOIN public.geo_areas ga ON ga.id = t.geo_area_id
    WHERE t.status_code IN ('active', 'past_due')
      -- Index-friendly prefilter for the same areas, p_max_distance_m wider.
      AND (
        (t.boundary_mode = 'radius'
          AND st_dwithin(t.map_center, p_point, t.service_radius_km * 1000 + p_max_distance_m))
        OR (t.boundary_mode = 'polygon' AND ga.boundary IS NOT NULL
          AND st_dwithin(ga.boundary, p_point, p_max_distance_m))
        OR (t.boundary_mode = 'polygon' AND ga.boundary IS NULL
          AND st_dwithin(t.map_center, p_point, p_max_distance_m))
      )
  ) c
  ORDER BY c.distance_m, c.center_m, c.id
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Metres from one tenant's area (whatever its status) to a point; a tenant
-- with only a centre is never at 0 (a centre is not an area).
CREATE OR REPLACE FUNCTION public.tenant_distance_m(p_tenant_id uuid, p_point geography)
RETURNS double precision
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    public.tenant_area_distance_m(t.boundary_mode, t.map_center, t.service_radius_km, ga.boundary, p_point),
    greatest(st_distance(t.map_center, p_point), 1e-9))
  FROM public.tenants t
  LEFT JOIN public.geo_areas ga ON ga.id = t.geo_area_id
  WHERE t.id = p_tenant_id
$$;
--> statement-breakpoint

-- Strictly inside (or on the edge of) one tenant's area, whatever its status.
CREATE OR REPLACE FUNCTION public.tenant_covers_point(p_tenant_id uuid, p_point geography)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    public.tenant_area_distance_m(t.boundary_mode, t.map_center, t.service_radius_km, ga.boundary, p_point) = 0,
    false)
  FROM public.tenants t
  LEFT JOIN public.geo_areas ga ON ga.id = t.geo_area_id
  WHERE t.id = p_tenant_id
$$;
--> statement-breakpoint

-- ---- 4. Settings --------------------------------------------------------------

DELETE FROM public.platform_settings WHERE key IN ('map_style_fallback', 'search_suggest_limit');
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('client_config_refresh_minutes', '360', 'integer', 'minutes', 5, 10080, 'none',
   'How old a phone''s cached tenant config (limits, flags, categories) may get before the app refreshes it in the background.'),
  ('search_description_max_chars', '2000', 'integer', 'characters', 200, 20000, 'none',
   'How much of a description the search index keeps (and so how much of it is searchable); the full text stays in the database.');
--> statement-breakpoint

-- ---- 2b. The discovery functions, on post_is_listed ------------------------

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.discover_nearby(p_point geography, p_radius_km double precision, p_kinds text[], p_category_ids uuid[], p_limit integer, p_offset integer)
 RETURNS TABLE(entity text, id uuid, tenant_id uuid, distance_m double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  max_page_size integer;
  radius_m double precision;
BEGIN
  IF p_point IS NULL OR p_radius_km IS NULL OR p_radius_km <= 0 THEN
    RAISE EXCEPTION 'discover_nearby needs a point and a positive radius'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'discover_nearby needs a positive limit and a non-negative offset'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'search_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO max_page_size
  FROM public.platform_settings ps WHERE ps.key = 'search_page_size_max';
  IF max_radius_km IS NULL OR max_page_size IS NULL THEN
    RAISE EXCEPTION 'platform settings search_max_radius_km / search_page_size_max are missing';
  END IF;

  radius_m := least(p_radius_km, max_radius_km) * 1000;

  RETURN QUERY
    SELECT d.entity, d.id, d.tenant_id, d.distance_m
    FROM (
      SELECT 'post'::text AS entity, p.id, p.tenant_id,
             st_distance(p.location, p_point) AS distance_m
      FROM public.posts p
      WHERE 'post' = ANY (p_kinds)
        -- post_is_listed (0049) inlines to posts_location_gist_idx's predicate.
        AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.expires_at, now())
        AND st_dwithin(p.location, p_point, radius_m)
        AND (p_category_ids IS NULL OR p.category_id = ANY (p_category_ids))
      UNION ALL
      SELECT 'store'::text, s.id, s.tenant_id, st_distance(s.location, p_point)
      FROM public.stores s
      WHERE 'store' = ANY (p_kinds)
        AND p_category_ids IS NULL
        AND s.status_code = 'active' AND s.deleted_at IS NULL
        AND st_dwithin(s.location, p_point, radius_m)
      UNION ALL
      SELECT 'place'::text, pl.id, pl.tenant_id, st_distance(pl.location, p_point)
      FROM public.places pl
      WHERE 'place' = ANY (p_kinds)
        AND pl.status_code IN ('published', 'temporarily_closed', 'permanently_closed')
        AND pl.deleted_at IS NULL
        AND st_dwithin(pl.location, p_point, radius_m)
        AND (p_category_ids IS NULL OR pl.category_id = ANY (p_category_ids))
    ) d
    ORDER BY d.distance_m, d.id
    LIMIT least(p_limit, max_page_size)
    OFFSET p_offset;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.feed_posts(p_origin geography, p_radius_km double precision, p_category_ids uuid[], p_shippable_only boolean, p_field_filters jsonb, p_boost_placement text, p_rank jsonb, p_as_of timestamp with time zone, p_after_score double precision, p_after_id uuid, p_limit integer)
 RETURNS TABLE(id uuid, tenant_id uuid, score double precision, distance_m double precision, is_boosted boolean, is_highlighted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  max_page_size integer;
  slots_default integer;
  radius_m double precision;
  as_of timestamptz;
  w_distance double precision := (p_rank ->> 'w_distance')::double precision;
  w_recency double precision := (p_rank ->> 'w_recency')::double precision;
  w_boost double precision := (p_rank ->> 'w_boost')::double precision;
  w_trust double precision := (p_rank ->> 'w_trust')::double precision;
  w_completeness double precision := (p_rank ->> 'w_completeness')::double precision;
  distance_half_m double precision := (p_rank ->> 'distance_half_km')::double precision * 1000;
  recency_half_life_s double precision := (p_rank ->> 'recency_half_life_hours')::double precision * 3600;
  photo_target double precision := (p_rank ->> 'photo_target')::double precision;
  trust_default double precision := (p_rank ->> 'trust_default')::double precision;
  page_size integer;
  boosted_ids uuid[];
  highlighted_ids uuid[];
  schema_fields jsonb;
BEGIN
  IF p_origin IS NULL OR p_as_of IS NULL OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'feed_posts needs an origin, as_of and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_radius_km IS NULL AND NOT coalesce(p_shippable_only, false) THEN
    RAISE EXCEPTION 'feed_posts without a radius is only for shippable categories'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_radius_km IS NOT NULL AND p_radius_km <= 0 THEN
    RAISE EXCEPTION 'feed_posts needs a positive radius' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_after_score IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'feed_posts cursor needs both score and id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- coalesce(..., false): a missing key makes the comparison NULL, and that
  -- must fail too. Weights must be >= 0 for the trust bound below to hold.
  IF NOT coalesce(w_distance >= 0 AND w_recency >= 0 AND w_boost >= 0 AND w_trust >= 0
                  AND w_completeness >= 0 AND trust_default BETWEEN 0 AND 100
                  AND distance_half_m > 0 AND recency_half_life_s > 0 AND photo_target > 0, false) THEN
    RAISE EXCEPTION 'feed_posts ranking parameters are missing or out of range'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'feed_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO max_page_size
  FROM public.platform_settings ps WHERE ps.key = 'feed_page_size_max';
  SELECT (ps.value #>> '{}')::integer INTO slots_default
  FROM public.platform_settings ps WHERE ps.key = 'boost_slots_per_category';
  IF max_radius_km IS NULL OR max_page_size IS NULL OR slots_default IS NULL THEN
    RAISE EXCEPTION 'platform settings feed_max_radius_km / feed_page_size_max / boost_slots_per_category are missing';
  END IF;

  -- least() skips NULLs: no radius must stay no radius.
  radius_m := CASE WHEN p_radius_km IS NOT NULL THEN least(p_radius_km, max_radius_km) * 1000 END;
  -- A cursor can't move the clock forward.
  as_of := least(p_as_of, now());
  page_size := least(p_limit, max_page_size);

  -- 1. The small sets, into variables, so the per-post pass below has no
  --    joins whose row estimates could go wrong (PostGIS estimates the
  --    st_dwithin filter at a handful of rows, whatever the radius).
  SELECT coalesce(array_agg(ranked.post_id), '{}')
    INTO boosted_ids
  FROM (
    SELECT b.tenant_id, b.post_id,
           row_number() OVER (PARTITION BY b.tenant_id, bp.category_id ORDER BY b.starts_at, b.id) AS slot
    FROM public.boosts b
    JOIN public.boost_types bt ON bt.id = b.boost_type_id
    JOIN public.posts bp ON bp.tenant_id = b.tenant_id AND bp.id = b.post_id
    WHERE b.status_code = 'active' AND b.post_id IS NOT NULL
      AND b.starts_at <= as_of AND b.ends_at > as_of
      AND bt.placement_code = p_boost_placement
      AND public.post_is_listed(bp.status_code, bp.deleted_at, bp.scrubbed_at, bp.hidden_by_owner, bp.expires_at, as_of)
  ) ranked
  LEFT JOIN public.tenant_settings ts ON ts.tenant_id = ranked.tenant_id
  WHERE ranked.slot <= coalesce((ts.setting_overrides ->> 'boost_slots_per_category')::integer, slots_default);

  SELECT coalesce(array_agg(DISTINCT b.post_id), '{}')
    INTO highlighted_ids
  FROM public.boosts b
  JOIN public.boost_types bt ON bt.id = b.boost_type_id
  WHERE b.status_code = 'active' AND b.post_id IS NOT NULL
    AND b.starts_at <= as_of AND b.ends_at > as_of
    AND bt.placement_code = 'highlight';

  SELECT coalesce(jsonb_object_agg(s.id::text, (
           SELECT count(*) FROM jsonb_object_keys(
             CASE WHEN jsonb_typeof(s.json_schema -> 'properties') = 'object'
                  THEN s.json_schema -> 'properties' ELSE '{}'::jsonb END))), '{}')
    INTO schema_fields
  FROM public.category_field_schemas s
  WHERE p_category_ids IS NULL OR s.category_id = ANY (p_category_ids);

  -- 2. One pass over the posts in scope: every term but trust (`base`).
  -- 3. Trust adds w_trust * t/100 with t in [0, 100], so score is in
  --    [base, base + w_trust]. B = the page_size-th best base among rows
  --    surely past the cursor (base + w_trust < cursor): at least page_size
  --    rows score >= B, so a row with base + w_trust < B can't make the page
  --    and never pays for its trust lookup. Exact, not approximate.
  RETURN QUERY
    WITH base AS MATERIALIZED (
      SELECT p.id, p.tenant_id, p.author_member_id, d.distance_m,
             d.is_boosted,
             p.id = ANY (highlighted_ids) AS is_highlighted,
             -- Exponents capped so a far or old post decays to ~0 instead of
             -- raising a float underflow.
             ( w_distance * coalesce(power(0.5::double precision,
                                          least(d.distance_m / distance_half_m, 1000)), 0)
             + w_recency * power(0.5::double precision,
                                 least(greatest(d.age_s, 0) / recency_half_life_s, 1000))
             + w_boost * d.is_boosted::integer
             + w_completeness * (
                 least(p.photo_count, photo_target) / photo_target
                 + CASE WHEN d.schema_fields > 0
                        THEN least(p.filled_field_count, d.schema_fields) / d.schema_fields
                        ELSE 1 END
               ) / 2
             )::double precision AS base_score
      FROM public.posts p
      CROSS JOIN LATERAL (
        SELECT st_distance(p.location, p_origin, false) AS distance_m,
               extract(epoch FROM as_of - coalesce(p.bumped_at, p.published_at))::double precision AS age_s,
               p.id = ANY (boosted_ids) AS is_boosted,
               coalesce((schema_fields ->> p.field_schema_id::text)::double precision, 0) AS schema_fields
      ) d
      -- post_is_listed (0049) inlines to the live-post partial indexes' predicate.
      WHERE public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.expires_at, as_of)
        AND coalesce(p.bumped_at, p.published_at) <= as_of
        AND (radius_m IS NULL OR st_dwithin(p.location, p_origin, radius_m, false))
        AND (p_category_ids IS NULL OR p.category_id = ANY (p_category_ids))
        AND (NOT coalesce(p_shippable_only, false) OR p.category_id IN (
              SELECT c.id FROM public.categories c WHERE c.is_shippable AND c.deleted_at IS NULL))
        AND (p_field_filters IS NULL OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(p_field_filters) f (value)
              WHERE NOT coalesce(public.post_field_filter_matches(p.fields, f.value), false)))
    ),
    eligible AS MATERIALIZED (
      -- score >= base, so a row with base > cursor was on an earlier page.
      SELECT b.* FROM base b WHERE p_after_score IS NULL OR b.base_score <= p_after_score
    ),
    bound AS MATERIALIZED (
      SELECT min(t.base_score) AS b, count(*) AS n
      FROM (
        SELECT e.base_score FROM eligible e
        WHERE p_after_score IS NULL OR e.base_score + w_trust < p_after_score
        ORDER BY e.base_score DESC
        LIMIT page_size
      ) t
    ),
    -- MATERIALIZED so the cursor test below isn't pushed under the bound and
    -- run (with its trust lookup) on every eligible row.
    scored AS MATERIALIZED (
      SELECT e.id, e.tenant_id, e.distance_m, e.is_boosted, e.is_highlighted,
             (e.base_score + w_trust * (coalesce(
                (SELECT coalesce(m.override_score, m.score)::double precision
                 FROM public.member_trust_scores m
                 WHERE m.tenant_id = e.tenant_id AND m.member_id = e.author_member_id),
                trust_default) / 100::double precision))::double precision AS score
      FROM eligible e
      CROSS JOIN bound
      WHERE bound.n < page_size OR e.base_score + w_trust >= bound.b
    )
    SELECT s.id, s.tenant_id, s.score, s.distance_m, s.is_boosted, s.is_highlighted
    FROM scored s
    WHERE p_after_score IS NULL OR (s.score, s.id) < (p_after_score, p_after_id)
    ORDER BY s.score DESC, s.id DESC
    LIMIT page_size;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.heatmap_cells(p_type text, p_category_slug text, p_precision integer, p_window_days integer, p_min_people integer, p_limit integer)
 RETURNS TABLE(geohash text, lat double precision, lng double precision, count integer, people integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_categories uuid[];
  v_area geography;
  v_reach_m double precision;
BEGIN
  IF v_tenant IS NULL OR NOT (public.app_is_tenant_admin() OR public.app_is_platform()) THEN
    RAISE EXCEPTION 'heatmap_cells: tenant admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type NOT IN ('demand', 'supply') OR p_precision IS NULL OR p_precision < 1 OR p_precision > 12
     OR p_min_people IS NULL OR p_min_people < 2 OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'heatmap_cells: bad arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Where this tenant's saved searches can be: its area (or centre, radius
  -- mode) plus the widest boundary buffer; resolve_owning_tenant decides.
  SELECT CASE WHEN t.boundary_mode = 'radius' OR g.boundary IS NULL THEN t.map_center ELSE g.boundary END,
         CASE WHEN t.boundary_mode = 'radius' THEN coalesce(t.service_radius_km, 0) * 1000 ELSE 0 END
         + 1000 * greatest(
             (SELECT (ps.value #>> '{}')::double precision FROM public.platform_settings ps
              WHERE ps.key = 'boundary_buffer_km'),
             coalesce((SELECT max((ts.setting_overrides ->> 'boundary_buffer_km')::double precision)
                       FROM public.tenant_settings ts
                       WHERE ts.setting_overrides ? 'boundary_buffer_km'), 0))
    INTO v_area, v_reach_m
  FROM public.tenants t LEFT JOIN public.geo_areas g ON g.id = t.geo_area_id WHERE t.id = v_tenant;
  IF p_category_slug IS NOT NULL THEN
    WITH RECURSIVE tree AS (
      SELECT c.id FROM public.categories c WHERE c.slug = p_category_slug AND c.deleted_at IS NULL
      UNION ALL
      SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id WHERE c.deleted_at IS NULL
    )
    SELECT coalesce(array_agg(tree.id), '{}') INTO v_categories FROM tree;
  END IF;

  RETURN QUERY
    WITH events AS (
      SELECT q.origin::geometry AS g, coalesce(q.user_id::text, 's:' || q.searcher_hash) AS person
      FROM public.search_queries q
      WHERE p_type = 'demand' AND q.tenant_id = v_tenant AND q.origin IS NOT NULL
        AND q.created_at >= now() - make_interval(days => p_window_days)
        AND (v_categories IS NULL OR q.category_id = ANY (v_categories))
      UNION ALL
      -- Saved searches belong to a user, not a tenant: the tenant's are the
      -- ones whose centre it owns, by the one ownership rule
      -- (resolve_owning_tenant, as unmet_demand uses), near its area first.
      SELECT ss.center::geometry, ss.user_id::text
      FROM public.saved_searches ss
      WHERE p_type = 'demand' AND v_area IS NOT NULL AND st_dwithin(ss.center, v_area, v_reach_m)
        AND (SELECT o.tenant_id FROM public.resolve_owning_tenant(ss.center, NULL) o LIMIT 1) = v_tenant
        AND ss.is_active AND ss.paused_at IS NULL AND ss.deleted_at IS NULL
        AND (v_categories IS NULL OR ss.category_id = ANY (v_categories))
      UNION ALL
      SELECT p.location::geometry, p.author_member_id::text
      FROM public.posts p
      WHERE p_type = 'supply' AND p.tenant_id = v_tenant
        AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.expires_at, now())
        AND p.location IS NOT NULL AND p.author_member_id IS NOT NULL
        AND (v_categories IS NULL OR p.category_id = ANY (v_categories))
      UNION ALL
      SELECT coalesce(s.location, pl.location)::geometry, s.owner_member_id::text
      FROM public.stores s
      LEFT JOIN public.places pl ON pl.tenant_id = s.tenant_id AND pl.id = s.place_id
      WHERE p_type = 'supply' AND v_categories IS NULL AND s.tenant_id = v_tenant
        AND s.status_code = 'active' AND s.deleted_at IS NULL
        AND coalesce(s.location, pl.location) IS NOT NULL
    ),
    cells AS (
      SELECT st_geohash(e.g, p_precision) AS gh, count(*)::integer AS n,
             count(DISTINCT e.person)::integer AS people
      FROM events e
      GROUP BY 1
      HAVING count(DISTINCT e.person) >= p_min_people
    )
    SELECT c.gh, st_y(st_pointfromgeohash(c.gh)), st_x(st_pointfromgeohash(c.gh)), c.n, c.people
    FROM cells c
    ORDER BY c.n DESC, c.gh
    LIMIT p_limit;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.map_features(p_min_lng double precision, p_min_lat double precision, p_max_lng double precision, p_max_lat double precision, p_zoom integer, p_layers text[], p_category_slug text, p_open_now boolean, p_center_lat double precision, p_center_lng double precision, p_limit integer, p_kinds text[])
 RETURNS TABLE(layer text, point_count integer, lng double precision, lat double precision, id uuid, tenant_id uuid, name_bn text, name_en text, category_slug text, price text, slug text, info_kind text, open_now boolean, kind text, open_state text, open_changes_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  max_radius_km double precision;
  cell_px_setting integer;
  until_zoom integer;
  max_items integer;
  center geography;
  center_lng double precision;
  center_lat double precision;
  lng_scale double precision;
  box_fits boolean;
  radius_m double precision;
  envelope geometry;
  cell_px double precision;
  world_px double precision;
  cluster boolean;
  category_ids uuid[];
  info_place_categories text[];
  info_category_ids uuid[];
  envelope_g geography;
  kind_rules jsonb;
  open_only boolean := coalesce(p_open_now, false);
BEGIN
  IF p_min_lng IS NULL OR p_min_lat IS NULL OR p_max_lng IS NULL OR p_max_lat IS NULL
     OR p_min_lng >= p_max_lng OR p_min_lat >= p_max_lat
     OR p_min_lat < -90 OR p_max_lat > 90 OR p_min_lng < -180 OR p_max_lng > 180 THEN
    RAISE EXCEPTION 'map_features needs a bbox minLng < maxLng, minLat < maxLat'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_zoom IS NULL OR p_zoom < 0 OR p_zoom > 24 OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'map_features needs a zoom 0-24 and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_center_lat IS NULL) <> (p_center_lng IS NULL) THEN
    RAISE EXCEPTION 'map_features needs both centre coordinates or neither'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT (ps.value #>> '{}')::double precision INTO max_radius_km
  FROM public.platform_settings ps WHERE ps.key = 'map_viewport_max_radius_km';
  SELECT (ps.value #>> '{}')::integer INTO cell_px_setting
  FROM public.platform_settings ps WHERE ps.key = 'map_cluster_cell_px';
  SELECT (ps.value #>> '{}')::integer INTO until_zoom
  FROM public.platform_settings ps WHERE ps.key = 'map_cluster_until_zoom';
  SELECT (ps.value #>> '{}')::integer INTO max_items
  FROM public.platform_settings ps WHERE ps.key = 'map_features_max';
  SELECT coalesce(array(SELECT jsonb_array_elements_text(ps.value)), '{}') INTO info_place_categories
  FROM public.platform_settings ps WHERE ps.key = 'map_info_place_categories';
  IF max_radius_km IS NULL OR cell_px_setting IS NULL OR until_zoom IS NULL OR max_items IS NULL THEN
    RAISE EXCEPTION 'platform settings map_viewport_max_radius_km / map_cluster_cell_px / map_cluster_until_zoom / map_features_max are missing';
  END IF;

  radius_m := max_radius_km * 1000;
  envelope := st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326);
  envelope_g := envelope::geography;
  IF p_center_lat IS NOT NULL THEN
    center := st_setsrid(st_makepoint(p_center_lng, p_center_lat), 4326)::geography;
    box_fits := false;
  ELSE
    center := st_setsrid(st_makepoint((p_min_lng + p_max_lng) / 2, (p_min_lat + p_max_lat) / 2), 4326)::geography;
    IF st_distance(center, st_setsrid(st_makepoint(p_max_lng, p_max_lat), 4326)::geography) > radius_m THEN
      RAISE EXCEPTION 'map_features: a box wider than map_viewport_max_radius_km needs a centre'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    box_fits := true;
  END IF;

  center_lng := st_x(center::geometry);
  center_lat := st_y(center::geometry);
  lng_scale := cos(radians(center_lat)) ^ 2;

  cluster := p_zoom < until_zoom;
  cell_px := 256.0 / greatest(1, round(256.0 / cell_px_setting));
  world_px := 256 * power(2, p_zoom);

  IF p_category_slug IS NOT NULL THEN
    WITH RECURSIVE tree AS (
      SELECT c.id FROM public.categories c
      WHERE c.slug = p_category_slug AND c.deleted_at IS NULL AND c.is_active
      UNION ALL
      SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id
      WHERE c.deleted_at IS NULL AND c.is_active
    )
    SELECT coalesce(array_agg(tree.id), '{}') INTO category_ids FROM tree;
  END IF;

  WITH RECURSIVE tree AS (
    SELECT c.id FROM public.categories c
    WHERE c.slug = ANY (coalesce(info_place_categories, '{}')) AND c.kind_code = 'place'
      AND c.deleted_at IS NULL AND c.is_active
    UNION ALL
    SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id
    WHERE c.deleted_at IS NULL AND c.is_active
  )
  SELECT coalesce(array_agg(tree.id), '{}') INTO info_category_ids FROM tree;

  WITH RECURSIVE src AS (
    SELECT k.ord, k.def ->> 'code' AS code, s.src ->> 'table' AS tbl,
           s.src -> 'categories' AS cats, s.src -> 'service_types' AS types, s.idx
    FROM jsonb_array_elements(
           coalesce((SELECT ps.value FROM public.platform_settings ps WHERE ps.key = 'map_kinds'), '[]'))
         WITH ORDINALITY AS k(def, ord),
         jsonb_array_elements(k.def -> 'sources') WITH ORDINALITY AS s(src, idx)
  ),
  roots AS (
    SELECT src.ord, src.idx, c.id
    FROM src
    CROSS JOIN LATERAL jsonb_array_elements_text(src.cats) AS slug(value)
    JOIN public.categories c ON c.slug = slug.value AND c.deleted_at IS NULL AND c.is_active
  ),
  tree AS (
    SELECT * FROM roots
    UNION ALL
    SELECT t.ord, t.idx, c.id FROM tree t
    JOIN public.categories c ON c.parent_id = t.id AND c.deleted_at IS NULL AND c.is_active
  )
  SELECT coalesce(jsonb_agg(
           jsonb_build_object('ord', src.ord * 1000 + src.idx, 'code', src.code, 'table', src.tbl)
           || CASE WHEN src.cats IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('category_ids',
                coalesce((SELECT jsonb_agg(t.id) FROM tree t WHERE t.ord = src.ord AND t.idx = src.idx), '[]'))
              END
           || CASE WHEN src.types IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('service_types', src.types) END),
         '[]')
  INTO kind_rules
  FROM src;

  RETURN QUERY
    -- Phase 1, light: which features are in the box. The open state is only
    -- computed here when open_now filters on it; otherwise for the picked
    -- single features in phase 2.
    WITH rules AS (
      SELECT (r ->> 'ord')::integer AS ord, r ->> 'code' AS code, r ->> 'table' AS tbl,
             CASE WHEN r ? 'category_ids'
                  THEN ARRAY(SELECT jsonb_array_elements_text(r -> 'category_ids'))::uuid[] END AS cats,
             CASE WHEN r ? 'service_types'
                  THEN ARRAY(SELECT jsonb_array_elements_text(r -> 'service_types')) END AS types
      FROM jsonb_array_elements(kind_rules) AS r
    ),
    base AS (
      SELECT 'posts'::text AS layer, p.id, p.tenant_id, p.location::geometry AS g,
             'posts'::text AS src, p.category_id, NULL::text AS service_type
      FROM public.posts p
      WHERE 'posts' = ANY (p_layers)
        AND NOT open_only
        -- Like feed_posts: past expires_at counts as gone before the expiry job runs.
        AND public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.expires_at, now())
        AND p.location && envelope_g AND p.location::geometry && envelope
        AND (box_fits OR st_dwithin(p.location, center, radius_m))
        AND (category_ids IS NULL OR p.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'stores'::text, s.id, s.tenant_id, s.location::geometry, 'stores'::text, NULL::uuid, NULL::text
      FROM public.stores s
      WHERE 'stores' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND s.status_code = 'active' AND s.deleted_at IS NULL AND s.location IS NOT NULL
        AND s.location && envelope_g AND s.location::geometry && envelope
        AND (box_fits OR st_dwithin(s.location, center, radius_m))
      UNION ALL
      SELECT pk.layer, pl.id, pl.tenant_id, pl.location::geometry, 'places'::text, pl.category_id, NULL::text
      FROM public.places pl
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN pl.category_id = ANY (info_category_ids) THEN 'info'
                 WHEN pl.is_landmark THEN 'landmarks'
                 ELSE 'places'
               END::text AS layer
      ) pk
      WHERE pk.layer = ANY (p_layers)
        AND pl.status_code IN ('published', 'temporarily_closed') AND pl.deleted_at IS NULL
        AND pl.location && envelope_g AND pl.location::geometry && envelope
        AND (box_fits OR st_dwithin(pl.location, center, radius_m))
        AND (category_ids IS NULL OR pl.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'info'::text, e.id, e.tenant_id, e.location::geometry, 'emergency'::text, NULL::uuid, e.service_type_code
      FROM public.emergency_contacts e
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND e.is_active AND e.deleted_at IS NULL AND e.location IS NOT NULL
        AND e.location && envelope_g AND e.location::geometry && envelope
        AND (box_fits OR st_dwithin(e.location, center, radius_m))
      UNION ALL
      SELECT 'info'::text, st.id, st.tenant_id, st.location::geometry, 'bus_stops'::text, NULL::uuid, NULL::text
      FROM public.transport_route_stops st
      JOIN public.transport_routes r ON r.tenant_id = st.tenant_id AND r.id = st.transport_route_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND r.is_active AND r.deleted_at IS NULL AND st.location IS NOT NULL
        AND st.location && envelope_g AND st.location::geometry && envelope
        AND (box_fits OR st_dwithin(st.location, center, radius_m))
    ),
    raw AS (
      SELECT b.*, o.state AS ostate, o.changes_at AS ochanges
      FROM base b
      -- is_open_at only when the condition holds: CASE guarantees the call is
      -- skipped, and OFFSET 0 keeps the planner from flattening this lateral
      -- back into a join filter applied after the call (0048).
      CROSS JOIN LATERAL (
        SELECT CASE WHEN open_only AND b.src IN ('stores', 'places', 'emergency')
                 THEN public.is_open_at(
                        CASE b.src WHEN 'stores' THEN 'store' WHEN 'places' THEN 'place' ELSE 'emergency' END,
                        b.id, now())
               END AS x
        OFFSET 0
      ) o0
      CROSS JOIN LATERAL (SELECT (o0.x).state, (o0.x).changes_at) o
      -- Bus stops are always "open"; everything else by is_open_at.
      WHERE NOT open_only OR b.src = 'bus_stops' OR o.state IN ('open', 'closes_soon')
    ),
    pts AS (
      SELECT raw.layer, raw.id, raw.tenant_id, raw.g, raw.src, raw.ostate, raw.ochanges, kk.code AS kind
      FROM raw
      LEFT JOIN LATERAL (
        SELECT ru.code FROM rules ru
        WHERE ru.tbl = raw.src
          AND (ru.cats IS NULL OR raw.category_id = ANY (ru.cats))
          AND (ru.types IS NULL OR raw.service_type = ANY (ru.types))
        ORDER BY ru.ord
        LIMIT 1
      ) kk ON true
      WHERE p_kinds IS NULL OR kk.code = ANY (p_kinds)
    ),
    keyed AS (
      SELECT pts.*,
             floor((st_x(pts.g) + 180) / 360 * world_px / cell_px) AS cx,
             floor((0.5 - ln(tan(pi() / 4 + radians(least(85.0511287798066, greatest(-85.0511287798066, st_y(pts.g)))) / 2)) / (2 * pi()))
                   * world_px / cell_px) AS cy
      FROM pts
      WHERE cluster
    ),
    cells AS (
      SELECT k.layer, k.kind, count(*)::integer AS n, avg(st_x(k.g)) AS lng, avg(st_y(k.g)) AS lat,
             CASE WHEN count(*) = 1 THEN max(k.id::text)::uuid END AS id,
             CASE WHEN count(*) = 1 THEN max(k.tenant_id::text)::uuid END AS tenant_id,
             CASE WHEN count(*) = 1 THEN max(k.src) END AS src,
             CASE WHEN count(*) = 1 THEN max(k.ostate) END AS ostate,
             CASE WHEN count(*) = 1 THEN max(k.ochanges) END AS ochanges
      FROM keyed k
      GROUP BY k.layer, k.kind, k.cx, k.cy
    ),
    candidates AS (
      SELECT * FROM cells
      UNION ALL
      SELECT pts.layer, pts.kind, 1, st_x(pts.g), st_y(pts.g), pts.id, pts.tenant_id, pts.src,
             pts.ostate, pts.ochanges
      FROM pts
      WHERE NOT cluster
    ),
    picked AS (
      SELECT c.*, (c.lng - center_lng) ^ 2 * lng_scale + (c.lat - center_lat) ^ 2 AS dist
      FROM candidates c
      ORDER BY c.n DESC, dist, c.layer, c.kind, c.id
      LIMIT least(p_limit, max_items + 1)
    ),
    -- Phase 2: the open state of each picked single feature (is_open_at,
    -- unless phase 1 already has it). Bus stops are always "open".
    stated AS (
      SELECT pk.*,
             CASE
               WHEN pk.n <> 1 THEN NULL
               WHEN pk.src = 'bus_stops' THEN 'open'
               WHEN pk.ostate IS NOT NULL THEN pk.ostate
               WHEN pk.src IN ('stores', 'places', 'emergency') THEN (os.x).state
             END AS st,
             CASE WHEN pk.n = 1 THEN coalesce(pk.ochanges, (os.x).changes_at) END AS chg
      FROM picked pk
      -- Same fix as phase 1: a post, a bus stop or a cluster never calls
      -- is_open_at (0048).
      CROSS JOIN LATERAL (
        SELECT CASE WHEN pk.n = 1 AND pk.ostate IS NULL AND pk.src IN ('stores', 'places', 'emergency')
                 THEN public.is_open_at(
                        CASE pk.src WHEN 'stores' THEN 'store' WHEN 'places' THEN 'place' ELSE 'emergency' END,
                        pk.id, now())
               END AS x
        OFFSET 0
      ) os
    )
    SELECT pk.layer, pk.n, pk.lng, pk.lat, pk.id, pk.tenant_id,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN p.title END
             ELSE coalesce(s.name_bn, pl.name_bn, e.name_bn, st.name_bn)
           END,
           CASE
             WHEN p.id IS NOT NULL THEN CASE WHEN p.title ~ '[ঀ-৿]' THEN NULL ELSE p.title END
             ELSE coalesce(s.name_en, pl.name_en, e.name_en, st.name_en)
           END,
           CASE WHEN pk.layer = 'info' THEN NULL ELSE coalesce(pc.slug, plc.slug) END,
           p.price::text,
           coalesce(s.slug, pl.slug),
           CASE
             WHEN pk.layer <> 'info' THEN NULL
             WHEN e.id IS NOT NULL THEN e.service_type_code
             WHEN st.id IS NOT NULL THEN 'bus_stop'
             ELSE plc.slug
           END,
           CASE WHEN pk.st IN ('open', 'closes_soon') THEN true
                WHEN pk.st IN ('closed', 'opens_soon') THEN false END,
           pk.kind,
           pk.st,
           pk.chg
    FROM stated pk
    LEFT JOIN public.posts p ON pk.n = 1 AND pk.src = 'posts' AND p.id = pk.id
    LEFT JOIN public.categories pc ON pc.id = p.category_id
    LEFT JOIN public.stores s ON pk.n = 1 AND pk.src = 'stores' AND s.id = pk.id
    LEFT JOIN public.places pl ON pk.n = 1 AND pk.src = 'places' AND pl.id = pk.id
    LEFT JOIN public.categories plc ON plc.id = pl.category_id
    LEFT JOIN public.emergency_contacts e ON pk.n = 1 AND pk.src = 'emergency' AND e.id = pk.id
    LEFT JOIN public.transport_route_stops st ON pk.n = 1 AND pk.src = 'bus_stops' AND st.id = pk.id
    ORDER BY pk.n DESC, pk.dist, pk.layer, pk.kind, pk.id;
END
$function$;
--> statement-breakpoint

-- The post page's rule, where these two spelled it out (0049).
CREATE OR REPLACE FUNCTION public.post_seller_card(p_post_id uuid, p_trusted_min smallint)
 RETURNS TABLE(display_name text, member_since timestamp with time zone, phone_verified boolean, trusted boolean, store_id uuid, store_slug text, store_name_bn text, store_name_en text, store_verified boolean, response_rate_pct numeric, median_response_seconds integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH post AS (
    SELECT p.tenant_id, p.author_member_id, p.store_id, p.contact_name
    FROM public.posts p
    WHERE p.id = p_post_id
      AND p.tenant_id = public.current_tenant_id()
      AND p.author_member_id IS NOT NULL
      AND p.scrubbed_at IS NULL
      AND (
        public.post_is_viewable(p.status_code, p.deleted_at, p.hidden_by_owner)
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
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.report_post(p_post_id uuid, p_reason_code text, p_details text)
 RETURNS TABLE(report_id uuid, created boolean, reporter_count integer, auto_hidden boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
    AND public.post_is_viewable(p.status_code, p.deleted_at, p.hidden_by_owner)
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
$function$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

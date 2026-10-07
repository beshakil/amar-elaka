-- 0048_map_and_heatmap_consistency
--
-- Performance fix found by the month 2 review (docs/status/month-2-review.md):
-- map_features() (0044) computed is_open_at() for EVERY place, store and
-- emergency contact in the box on every request, open_now or not. Its phase-1
-- LEFT JOIN LATERAL carried `ON open_only AND b.src IN (...)`; a join qual on
-- outer columns can't be pushed into the lateral, so the subquery (and
-- is_open_at) ran for each row and was discarded afterwards. With 3,000
-- places that was ~900 is_open_at calls and ~3.9 s per map request on the
-- dev laptop.
--
-- Phase 2 (the picked features) had the same pattern: every picked post,
-- bus stop and cluster called is_open_at too.
--
-- The same function, with each call behind a CASE in an OFFSET 0 lateral
-- (a plain WHERE inside the lateral isn't enough: the planner flattens a
-- simple subquery and turns it back into a join filter): phase 1 evaluates is_open_at only for open_now requests (where
-- the filter needs it); phase 2 only for the single places, stores and
-- emergency contacts it returns.
-- Also two consistency fixes from the same review (one rule each, as the
-- feed and unmet demand already apply it):
--   * map_features: a live post past expires_at leaves the map as it leaves
--     the feed (feed_posts, 0030), not up to 15 minutes later when the
--     expiry job sweeps it;
--   * heatmap_cells (0045): a saved search belongs to the tenant
--     resolve_owning_tenant() gives its centre (as for unmet_demand, 0035),
--     not to whichever tenant's polygon covers it (that ignored radius-mode
--     tenants and the boundary buffer); supply skips expired posts too.
-- No signature or column change. Tests: apps/api/test/map-features.db-spec.ts
-- (is_open_at is not called without open_now), apps/api/test/hours.e2e-spec.ts (open state
-- and open_now on the map).

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.map_features(
  p_min_lng double precision,
  p_min_lat double precision,
  p_max_lng double precision,
  p_max_lat double precision,
  p_zoom integer,
  p_layers text[],
  p_category_slug text,
  p_open_now boolean,
  p_center_lat double precision,
  p_center_lng double precision,
  p_limit integer,
  p_kinds text[]
)
RETURNS TABLE (
  layer text,
  point_count integer,
  lng double precision,
  lat double precision,
  id uuid,
  tenant_id uuid,
  name_bn text,
  name_en text,
  category_slug text,
  price text,
  slug text,
  info_kind text,
  open_now boolean,
  kind text,
  open_state text,
  open_changes_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        -- Like feed_posts: past expires_at counts as gone before the expiry job runs (0048).
        AND (p.expires_at IS NULL OR p.expires_at > now())
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
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.heatmap_cells(
  p_type text,
  p_category_slug text,
  p_precision integer,
  p_window_days integer,
  p_min_people integer,
  p_limit integer
)
RETURNS TABLE (geohash text, lat double precision, lng double precision, count integer, people integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        AND (p.expires_at IS NULL OR p.expires_at > now())
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
$$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

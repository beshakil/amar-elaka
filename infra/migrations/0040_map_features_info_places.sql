-- 0040_map_features_info_places
--
-- The map data API, second pass (ADR 045):
--
--   map_info_place_categories   setting: place categories (with their
--                               descendants) the map shows in the info layer
--                               instead of places — banks and ATMs
--                               (`bank-atm`). Their info_kind is the category
--                               slug.
--   map_features()              replaced (same signature, owner and grants):
--     * the info layer also takes those places;
--     * phase 1 picks the features from id, tenant and point only; phase 2
--       reads display columns for the ≤ map_features_max picked rows by
--       primary key — names, prices and categories are no longer computed for
--       every point in the box;
--     * the box filter is `location && envelope::geography`, which the GiST
--       indexes on location (geography) can use; 0039's
--       `location::geometry && envelope` could not, so it scanned the table.
--       The geometry test stays, after it, to keep exactly the box.
--
-- Only the owner may replace a function: SET ROLE ae_rls_bypass around it,
-- as 0024 does (ae_migrator is NOINHERIT).
--
-- No table, so no new RLS. Seed: the setting. Tests:
-- apps/api/test/map-features.db-spec.ts.

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('map_info_place_categories', '["bank-atm"]', 'text_array', NULL, NULL, NULL, 'none',
   'Place categories (slugs, with their subcategories) the map shows in the info layer — banks and ATMs — instead of the places layer.');
--> statement-breakpoint

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
  p_limit integer
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
  open_now boolean
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
  local_now timestamp;
  local_dow smallint;
  local_time time;
  category_ids uuid[];
  info_place_categories text[];
  info_category_ids uuid[];
  envelope_g geography;
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
  -- The GiST indexes are on location (geography): `location && envelope_g`
  -- uses them; `location::geometry && envelope` then keeps exactly the box.
  envelope_g := envelope::geography;
  IF p_center_lat IS NOT NULL THEN
    center := st_setsrid(st_makepoint(p_center_lng, p_center_lat), 4326)::geography;
    box_fits := false;
  ELSE
    -- No centre: the box must already fit in the radius around its own centre.
    center := st_setsrid(st_makepoint((p_min_lng + p_max_lng) / 2, (p_min_lat + p_max_lat) / 2), 4326)::geography;
    IF st_distance(center, st_setsrid(st_makepoint(p_max_lng, p_max_lat), 4326)::geography) > radius_m THEN
      RAISE EXCEPTION 'map_features: a box wider than map_viewport_max_radius_km needs a centre'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Every point of the box is within the radius: no per-row distance check.
    box_fits := true;
  END IF;

  center_lng := st_x(center::geometry);
  center_lat := st_y(center::geometry);
  -- Nearest-first ordering on the plane, longitude shrunk by cos²(latitude):
  -- the same order as the spheroid's within the radius, without 5,000
  -- st_distance calls.
  lng_scale := cos(radians(center_lat)) ^ 2;

  cluster := p_zoom < until_zoom;
  -- A whole number of cells per 256 px tile, so cells never straddle tiles.
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

  -- Place categories shown as info (banks, ATMs…), with their descendants.
  WITH RECURSIVE tree AS (
    SELECT c.id FROM public.categories c
    WHERE c.slug = ANY (coalesce(info_place_categories, '{}')) AND c.kind_code = 'place'
      AND c.deleted_at IS NULL AND c.is_active
    UNION ALL
    SELECT c.id FROM public.categories c JOIN tree t ON c.parent_id = t.id
    WHERE c.deleted_at IS NULL AND c.is_active
  )
  SELECT coalesce(array_agg(tree.id), '{}') INTO info_category_ids FROM tree;

  local_now := now() AT TIME ZONE 'Asia/Dhaka';
  local_dow := extract(isodow FROM local_now)::smallint;
  local_time := local_now::time;

  RETURN QUERY
    -- Phase 1, light: which features are in the box (id, tenant, point,
    -- open_now) — no names, no joins, so 5,000 rows stay cheap.
    WITH pts AS (
      SELECT 'posts'::text AS layer, p.id, p.tenant_id, p.location::geometry AS g,
             NULL::boolean AS open_now
      FROM public.posts p
      WHERE 'posts' = ANY (p_layers)
        AND NOT coalesce(p_open_now, false)
        -- posts_location_gist_idx's predicate, and its column: the index is used.
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        AND p.location && envelope_g AND p.location::geometry && envelope
        AND (box_fits OR st_dwithin(p.location, center, radius_m))
        AND (category_ids IS NULL OR p.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'stores'::text, s.id, s.tenant_id, s.location::geometry, NULL::boolean
      FROM public.stores s
      WHERE 'stores' = ANY (p_layers)
        AND p_category_slug IS NULL AND NOT coalesce(p_open_now, false)
        AND s.status_code = 'active' AND s.deleted_at IS NULL AND s.location IS NOT NULL
        AND s.location && envelope_g AND s.location::geometry && envelope
        AND (box_fits OR st_dwithin(s.location, center, radius_m))
      UNION ALL
      -- Places: landmarks, places, and (map_info_place_categories) info.
      SELECT pk.layer, pl.id, pl.tenant_id, pl.location::geometry, o.open_now
      FROM public.places pl
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN pl.category_id = ANY (info_category_ids) THEN 'info'
                 WHEN pl.is_landmark THEN 'landmarks'
                 ELSE 'places'
               END::text AS layer
      ) pk
      CROSS JOIN LATERAL (SELECT CASE
                 WHEN pl.status_code = 'temporarily_closed' THEN false
                 WHEN NOT EXISTS (SELECT 1 FROM public.place_hours h WHERE h.place_id = pl.id) THEN NULL
                 ELSE EXISTS (
                   SELECT 1 FROM public.place_hours h
                   WHERE h.place_id = pl.id AND (
                     (h.iso_day_of_week = local_dow AND h.opens_at <= local_time
                       AND (h.closes_next_day OR local_time < h.closes_at))
                     OR (h.closes_next_day AND local_time < h.closes_at
                       AND h.iso_day_of_week = CASE WHEN local_dow = 1 THEN 7 ELSE local_dow - 1 END)))
               END AS open_now) o
      WHERE pk.layer = ANY (p_layers)
        AND pl.status_code IN ('published', 'temporarily_closed') AND pl.deleted_at IS NULL
        AND pl.location && envelope_g AND pl.location::geometry && envelope
        AND (box_fits OR st_dwithin(pl.location, center, radius_m))
        AND (category_ids IS NULL OR pl.category_id = ANY (category_ids))
        AND (NOT coalesce(p_open_now, false) OR o.open_now)
      UNION ALL
      SELECT 'info'::text, e.id, e.tenant_id, e.location::geometry,
             CASE WHEN e.is_24h THEN true END
      FROM public.emergency_contacts e
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND e.is_active AND e.deleted_at IS NULL AND e.location IS NOT NULL
        AND e.location && envelope_g AND e.location::geometry && envelope
        AND (box_fits OR st_dwithin(e.location, center, radius_m))
        AND (NOT coalesce(p_open_now, false) OR e.is_24h)
      UNION ALL
      SELECT 'info'::text, st.id, st.tenant_id, st.location::geometry, true
      FROM public.transport_route_stops st
      JOIN public.transport_routes r ON r.tenant_id = st.tenant_id AND r.id = st.transport_route_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND r.is_active AND r.deleted_at IS NULL AND st.location IS NOT NULL
        AND st.location && envelope_g AND st.location::geometry && envelope
        AND (box_fits OR st_dwithin(st.location, center, radius_m))
    ),
    -- Below until_zoom: cells keyed on the Web Mercator pixel grid (the
    -- slippy-map formulas: x from longitude, y from the Mercator latitude,
    -- in world pixels at p_zoom, then whole cells).
    keyed AS (
      SELECT pts.*,
             floor((st_x(pts.g) + 180) / 360 * world_px / cell_px) AS cx,
             floor((0.5 - ln(tan(pi() / 4 + radians(least(85.0511287798066, greatest(-85.0511287798066, st_y(pts.g)))) / 2)) / (2 * pi()))
                   * world_px / cell_px) AS cy
      FROM pts
      WHERE cluster
    ),
    -- A cell of one is that feature (max() of one row is that row); a bigger
    -- cell is its count and centre.
    cells AS (
      SELECT k.layer, count(*)::integer AS n, avg(st_x(k.g)) AS lng, avg(st_y(k.g)) AS lat,
             CASE WHEN count(*) = 1 THEN max(k.id::text)::uuid END AS id,
             CASE WHEN count(*) = 1 THEN max(k.tenant_id::text)::uuid END AS tenant_id,
             CASE WHEN count(*) = 1 THEN bool_or(k.open_now) END AS open_now
      FROM keyed k
      GROUP BY k.layer, k.cx, k.cy
    ),
    -- From until_zoom every feature is its own row.
    candidates AS (
      SELECT * FROM cells
      UNION ALL
      SELECT pts.layer, 1, st_x(pts.g), st_y(pts.g), pts.id, pts.tenant_id, pts.open_now
      FROM pts
      WHERE NOT cluster
    ),
    -- The biggest clusters, then the nearest (on the plane, longitude shrunk
    -- by cos²(latitude): the spheroid's order within the radius).
    picked AS (
      SELECT c.*, (c.lng - center_lng) ^ 2 * lng_scale + (c.lat - center_lat) ^ 2 AS dist
      FROM candidates c
      ORDER BY c.n DESC, dist, c.layer, c.id
      LIMIT least(p_limit, max_items + 1)
    )
    -- Phase 2: display columns for the picked single features only, by
    -- primary key.
    SELECT pk.layer, pk.n, pk.lng, pk.lat, pk.id, pk.tenant_id,
           CASE
             -- A post has one title: it is the Bengali name when written in Bengali.
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
           pk.open_now
    FROM picked pk
    LEFT JOIN public.posts p ON pk.n = 1 AND pk.layer = 'posts' AND p.id = pk.id
    LEFT JOIN public.categories pc ON pc.id = p.category_id
    LEFT JOIN public.stores s ON pk.n = 1 AND pk.layer = 'stores' AND s.id = pk.id
    LEFT JOIN public.places pl
      ON pk.n = 1 AND pk.layer IN ('places', 'landmarks', 'info') AND pl.id = pk.id
    LEFT JOIN public.categories plc ON plc.id = pl.category_id
    LEFT JOIN public.emergency_contacts e ON pk.n = 1 AND pk.layer = 'info' AND e.id = pk.id
    LEFT JOIN public.transport_route_stops st ON pk.n = 1 AND pk.layer = 'info' AND st.id = pk.id
    ORDER BY pk.n DESC, pk.dist, pk.layer, pk.id;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer) IS
  'The map''s data (ADR 045): public-state posts/stores/places/landmarks/info (incl. map_info_place_categories places) in a box, radius-bounded, grid-clustered by zoom, with names in both languages. SECURITY DEFINER: only columns public-read already exposes.';
--> statement-breakpoint
RESET ROLE;

-- 0041_map_kinds_and_client_settings
--
-- The app's Map tab and LocationPicker (ADR 046):
--
--   setting_value_types   + 'json' (an object or array; the shape is checked
--                         by the API's settings registry, as every setting's).
--   map_kinds             the Map tab's toggles (hospital, pharmacy, food,
--                         gas, bank, bus stand, shops, listings): each a code,
--                         an icon key, Bengali/English labels and its sources
--                         — a table (posts, stores, places, emergency,
--                         bus_stops) with categories (and their descendants)
--                         or emergency service types. Order is priority: a
--                         feature takes the first kind it matches. Served to
--                         clients by GET /map/config.
--   client timings        geo_picker_idle_debounce_ms, geo_autocomplete_debounce_ms,
--                         map_search_area_move_ratio, map_pin_label_min_zoom,
--                         map_pin_label_max — the app reads them from
--                         GET /map/config, so none is hardcoded in it.
--   map_features()        gains p_kinds (NULL = no kind filter) and returns
--                         each feature's kind; clusters group per (layer, kind).
--                         The 11-argument version is DROPPED (a new signature
--                         cannot be CREATE OR REPLACEd); the API is the only
--                         caller and moves to the new one in the same change.
--
-- No table, so no new RLS. Seeds: the value type and the settings. Tests:
-- apps/api/test/map-features.db-spec.ts.

INSERT INTO public.setting_value_types (code, label_key, sort_order) VALUES
  ('json', 'enum.setting_value_types.json', 80);
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
    WHEN 'json' THEN
      jsonb_typeof(value) IN ('object', 'array')
    ELSE false
  END
$$;
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('geo_picker_idle_debounce_ms', '600', 'integer', 'ms', 100, 5000, 'none',
   'LocationPicker: how long the map must stay still before the point is looked up (one GET /geo/reverse per stop).'),
  ('geo_autocomplete_debounce_ms', '400', 'integer', 'ms', 100, 3000, 'none',
   'Address search boxes: how long typing must pause before GET /geo/autocomplete is called.'),
  ('map_search_area_move_ratio', '0.3', 'decimal', 'ratio', 0.05, 1, 'none',
   'Map tab: after the map moves this share of the viewport (or changes zoom), "Search this area" appears; panning never refetches by itself.'),
  ('map_pin_label_min_zoom', '17', 'integer', 'zoom', 12, 22, 'none',
   'Map tab: from this zoom the nearest pins get their Bengali name, drawn by the app (not map text).'),
  ('map_pin_label_max', '40', 'integer', 'count', 0, 200, 'none',
   'Map tab: at most this many pins carry a name image at once (memory on small phones).'),
  ('map_kinds', '[
    {"code": "hospital", "icon": "hospital", "label_bn": "হাসপাতাল", "label_en": "Hospitals",
     "sources": [{"table": "places", "categories": ["hospital-doctor-chambers"]},
                 {"table": "emergency", "service_types": ["hospital", "ambulance"]}]},
    {"code": "pharmacy", "icon": "pharmacy", "label_bn": "ফার্মেসি", "label_en": "Pharmacies",
     "sources": [{"table": "places", "categories": ["pharmacy"]},
                 {"table": "emergency", "service_types": ["pharmacy_24h"]}]},
    {"code": "food", "icon": "food", "label_bn": "খাবার", "label_en": "Food",
     "sources": [{"table": "places", "categories": ["restaurant-food"]},
                 {"table": "posts", "categories": ["homemade-food"]}]},
    {"code": "gas", "icon": "gas", "label_bn": "গ্যাস", "label_en": "Gas",
     "sources": [{"table": "posts", "categories": ["gas-cylinder"]},
                 {"table": "emergency", "service_types": ["gas"]}]},
    {"code": "bank", "icon": "bank", "label_bn": "ব্যাংক ও এটিএম", "label_en": "Banks & ATMs",
     "sources": [{"table": "places", "categories": ["bank-atm"]}]},
    {"code": "bus_stand", "icon": "bus", "label_bn": "বাস স্ট্যান্ড", "label_en": "Bus stands",
     "sources": [{"table": "bus_stops"}]},
    {"code": "shops", "icon": "shop", "label_bn": "দোকান", "label_en": "Shops",
     "sources": [{"table": "stores"}, {"table": "places", "categories": ["local-shop-directory"]}]},
    {"code": "listings", "icon": "listing", "label_bn": "বিজ্ঞাপন", "label_en": "Listings",
     "sources": [{"table": "posts"}]}
  ]', 'json', NULL, NULL, NULL, 'none',
   'Map tab toggles: code, icon key, labels and sources (table + categories or emergency service types). Order is priority.');
--> statement-breakpoint

-- The 11-argument map_features belongs to ae_rls_bypass: only it may drop it.
SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint
DROP FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer);
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

CREATE FUNCTION public.map_features(
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
  kind text
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
  kind_rules jsonb;
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

  -- map_kinds → one rule per (kind, source): which table, which categories
  -- (with their descendants) or service types. A feature takes the first
  -- kind (setting order) whose rule it matches.
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

  local_now := now() AT TIME ZONE 'Asia/Dhaka';
  local_dow := extract(isodow FROM local_now)::smallint;
  local_time := local_now::time;

  RETURN QUERY
    -- Phase 1, light: which features are in the box (id, tenant, point,
    -- open_now) — no names, no joins, so 5,000 rows stay cheap.
    WITH rules AS (
      SELECT (r ->> 'ord')::integer AS ord, r ->> 'code' AS code, r ->> 'table' AS tbl,
             CASE WHEN r ? 'category_ids'
                  THEN ARRAY(SELECT jsonb_array_elements_text(r -> 'category_ids'))::uuid[] END AS cats,
             CASE WHEN r ? 'service_types'
                  THEN ARRAY(SELECT jsonb_array_elements_text(r -> 'service_types')) END AS types
      FROM jsonb_array_elements(kind_rules) AS r
    ),
    raw AS (
      SELECT 'posts'::text AS layer, p.id, p.tenant_id, p.location::geometry AS g,
             NULL::boolean AS open_now, 'posts'::text AS src, p.category_id, NULL::text AS service_type
      FROM public.posts p
      WHERE 'posts' = ANY (p_layers)
        AND NOT coalesce(p_open_now, false)
        -- posts_location_gist_idx's predicate, and its column: the index is used.
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        AND p.location && envelope_g AND p.location::geometry && envelope
        AND (box_fits OR st_dwithin(p.location, center, radius_m))
        AND (category_ids IS NULL OR p.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'stores'::text, s.id, s.tenant_id, s.location::geometry, NULL::boolean,
             'stores'::text, NULL::uuid, NULL::text
      FROM public.stores s
      WHERE 'stores' = ANY (p_layers)
        AND p_category_slug IS NULL AND NOT coalesce(p_open_now, false)
        AND s.status_code = 'active' AND s.deleted_at IS NULL AND s.location IS NOT NULL
        AND s.location && envelope_g AND s.location::geometry && envelope
        AND (box_fits OR st_dwithin(s.location, center, radius_m))
      UNION ALL
      -- Places: landmarks, places, and (map_info_place_categories) info.
      SELECT pk.layer, pl.id, pl.tenant_id, pl.location::geometry, o.open_now,
             'places'::text, pl.category_id, NULL::text
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
             CASE WHEN e.is_24h THEN true END, 'emergency'::text, NULL::uuid, e.service_type_code
      FROM public.emergency_contacts e
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND e.is_active AND e.deleted_at IS NULL AND e.location IS NOT NULL
        AND e.location && envelope_g AND e.location::geometry && envelope
        AND (box_fits OR st_dwithin(e.location, center, radius_m))
        AND (NOT coalesce(p_open_now, false) OR e.is_24h)
      UNION ALL
      SELECT 'info'::text, st.id, st.tenant_id, st.location::geometry, true,
             'bus_stops'::text, NULL::uuid, NULL::text
      FROM public.transport_route_stops st
      JOIN public.transport_routes r ON r.tenant_id = st.tenant_id AND r.id = st.transport_route_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND r.is_active AND r.deleted_at IS NULL AND st.location IS NOT NULL
        AND st.location && envelope_g AND st.location::geometry && envelope
        AND (box_fits OR st_dwithin(st.location, center, radius_m))
    ),
    -- Each feature's kind (map_kinds), and the kinds filter.
    pts AS (
      SELECT raw.layer, raw.id, raw.tenant_id, raw.g, raw.open_now, kk.code AS kind
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
      SELECT k.layer, k.kind, count(*)::integer AS n, avg(st_x(k.g)) AS lng, avg(st_y(k.g)) AS lat,
             CASE WHEN count(*) = 1 THEN max(k.id::text)::uuid END AS id,
             CASE WHEN count(*) = 1 THEN max(k.tenant_id::text)::uuid END AS tenant_id,
             CASE WHEN count(*) = 1 THEN bool_or(k.open_now) END AS open_now
      FROM keyed k
      GROUP BY k.layer, k.kind, k.cx, k.cy
    ),
    -- From until_zoom every feature is its own row.
    candidates AS (
      SELECT * FROM cells
      UNION ALL
      SELECT pts.layer, pts.kind, 1, st_x(pts.g), st_y(pts.g), pts.id, pts.tenant_id, pts.open_now
      FROM pts
      WHERE NOT cluster
    ),
    -- The biggest clusters, then the nearest (on the plane, longitude shrunk
    -- by cos²(latitude): the spheroid's order within the radius).
    picked AS (
      SELECT c.*, (c.lng - center_lng) ^ 2 * lng_scale + (c.lat - center_lat) ^ 2 AS dist
      FROM candidates c
      ORDER BY c.n DESC, dist, c.layer, c.kind, c.id
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
           pk.open_now,
           pk.kind
    FROM picked pk
    LEFT JOIN public.posts p ON pk.n = 1 AND pk.layer = 'posts' AND p.id = pk.id
    LEFT JOIN public.categories pc ON pc.id = p.category_id
    LEFT JOIN public.stores s ON pk.n = 1 AND pk.layer = 'stores' AND s.id = pk.id
    LEFT JOIN public.places pl
      ON pk.n = 1 AND pk.layer IN ('places', 'landmarks', 'info') AND pl.id = pk.id
    LEFT JOIN public.categories plc ON plc.id = pl.category_id
    LEFT JOIN public.emergency_contacts e ON pk.n = 1 AND pk.layer = 'info' AND e.id = pk.id
    LEFT JOIN public.transport_route_stops st ON pk.n = 1 AND pk.layer = 'info' AND st.id = pk.id
    ORDER BY pk.n DESC, pk.dist, pk.layer, pk.kind, pk.id;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[]) IS
  'The map''s data (ADR 045, 046): public-state posts/stores/places/landmarks/info in a box, radius-bounded, grid-clustered by zoom per (layer, kind), with names in both languages and each feature''s map_kinds kind. SECURITY DEFINER: only columns public-read already exposes.';
--> statement-breakpoint
ALTER FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[])
  OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer, text[])
TO ae_app;

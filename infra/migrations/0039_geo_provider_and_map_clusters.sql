-- 0039_geo_provider_and_map_clusters
--
-- Week 8, behind our API (ADR 044): the geo provider layer (Barikoi) metered,
-- logged and budgeted, and server-side clustering for the map screens.
--
--   geo_provider_endpoints    lookup: autocomplete, reverse, geocode_address
--                             (Rupantor), route.
--   geo_provider_statuses     lookup: ok, empty, cache_hit, rate_limited,
--                             unauthorized, error, timeout, over_budget,
--                             disabled.
--   geo_provider_calls        PLATFORM log (not tenant-scoped): one row per
--                             provider request — a paid call, a cache hit, or
--                             one the budget/breaker refused. calls_counted is
--                             what Barikoi bills (0 for a cache hit). tenant_id
--                             is attribution only (nullable, SET NULL), never a
--                             scope. No query text, no coordinates. Purged
--                             after geo_provider_calls_retention_days by the
--                             purge-geo-provider-calls job.
--   map_features()            the map's data (ADR 045): public-state posts,
--                             stores, places, landmarks and info (emergency
--                             services, bus stops) in a tile-aligned box,
--                             grid-clustered by zoom, with display names in
--                             both languages (see below).
--
-- Notification types geo_budget_warning / geo_budget_exhausted: platform
-- admins hear when the day's Barikoi budget reaches barikoi_budget_warn_pct
-- and 100%.
--
-- Settings: every number the geo layer uses (CLAUDE.md rule 9) — provider
-- choice, budget and its warning, what each Barikoi operation costs in calls,
-- cache TTL and reverse-geocode cache precision (geohash), the fields each
-- reverse-geocode purpose may ask for, own-data threshold and radius, rate
-- limits, breaker cooldown, route rounding, log retention, map clustering.
-- Replaces two 0021 settings this layer no longer reads (rows deleted, no
-- column changes): geocode_cache_days → geo_cache_ttl_hours, and
-- geocode_reverse_cache_decimals → reverse_geocode_cache_precision.
--
-- Tests: apps/api/test/geo-provider-calls.db-spec.ts, map-features.db-spec.ts.

-- ============================================================================
-- Lookups
-- ============================================================================

CREATE TABLE public.geo_provider_endpoints (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geo_provider_endpoints_pk PRIMARY KEY (code),
  CONSTRAINT geo_provider_endpoints_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER geo_provider_endpoints_set_updated_at BEFORE UPDATE ON public.geo_provider_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.geo_provider_endpoints (code, label_key, sort_order) VALUES
  ('autocomplete',    'enum.geo_provider_endpoints.autocomplete',    10),
  ('reverse',         'enum.geo_provider_endpoints.reverse',         20),
  ('geocode_address', 'enum.geo_provider_endpoints.geocode_address', 30),
  ('route',           'enum.geo_provider_endpoints.route',           40);
--> statement-breakpoint

CREATE TABLE public.geo_provider_statuses (
  code        text        NOT NULL,
  label_key   text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geo_provider_statuses_pk PRIMARY KEY (code),
  CONSTRAINT geo_provider_statuses_code_ck CHECK (code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TRIGGER geo_provider_statuses_set_updated_at BEFORE UPDATE ON public.geo_provider_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
INSERT INTO public.geo_provider_statuses (code, label_key, sort_order) VALUES
  ('ok',           'enum.geo_provider_statuses.ok',           10),
  ('empty',        'enum.geo_provider_statuses.empty',        20),
  ('cache_hit',    'enum.geo_provider_statuses.cache_hit',    30),
  ('rate_limited', 'enum.geo_provider_statuses.rate_limited', 40),
  ('unauthorized', 'enum.geo_provider_statuses.unauthorized', 50),
  ('error',        'enum.geo_provider_statuses.error',        60),
  ('timeout',      'enum.geo_provider_statuses.timeout',      70),
  ('over_budget',  'enum.geo_provider_statuses.over_budget',  80),
  ('disabled',     'enum.geo_provider_statuses.disabled',     90);
--> statement-breakpoint

-- ============================================================================
-- geo_provider_calls
-- ============================================================================

CREATE TABLE public.geo_provider_calls (
  id              uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  provider        text        NOT NULL,
  endpoint        text        NOT NULL,
  -- Calls as the provider bills them (settings barikoi_cost_*): a reverse
  -- geocode is base + per field. 0 for a cache hit and for a request that
  -- never reached the provider (refused, timed out, network error).
  calls_counted   smallint    NOT NULL,
  cache_hit       boolean     NOT NULL DEFAULT false,
  latency_ms      integer,
  status          text        NOT NULL,
  -- Whose request it was, for cost attribution. Not a tenant scope.
  tenant_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geo_provider_calls_pk PRIMARY KEY (id),
  CONSTRAINT geo_provider_calls_endpoint_fk FOREIGN KEY (endpoint)
    REFERENCES public.geo_provider_endpoints (code) ON DELETE RESTRICT,
  CONSTRAINT geo_provider_calls_status_fk FOREIGN KEY (status)
    REFERENCES public.geo_provider_statuses (code) ON DELETE RESTRICT,
  CONSTRAINT geo_provider_calls_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE SET NULL,
  CONSTRAINT geo_provider_calls_provider_ck CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT geo_provider_calls_calls_counted_ck CHECK (calls_counted >= 0),
  CONSTRAINT geo_provider_calls_cache_hit_ck CHECK (NOT cache_hit OR calls_counted = 0),
  CONSTRAINT geo_provider_calls_latency_ms_ck CHECK (latency_ms IS NULL OR latency_ms >= 0)
);
--> statement-breakpoint
-- Today's spend (the budget's count when Redis is down), daily usage reports
-- and the retention purge all read by provider and time.
CREATE INDEX geo_provider_calls_provider_created_idx
  ON public.geo_provider_calls (provider, created_at DESC);
--> statement-breakpoint
CREATE INDEX geo_provider_calls_created_idx ON public.geo_provider_calls (created_at);
--> statement-breakpoint
CREATE INDEX geo_provider_calls_tenant_id_idx ON public.geo_provider_calls (tenant_id)
  WHERE tenant_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER geo_provider_calls_set_updated_at BEFORE UPDATE ON public.geo_provider_calls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.geo_provider_endpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.geo_provider_endpoints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.geo_provider_statuses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.geo_provider_statuses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.geo_provider_calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.geo_provider_calls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Enum tables: read by all, write by platform admin (as 0005).
CREATE POLICY geo_provider_endpoints_read_all ON public.geo_provider_endpoints
  FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY geo_provider_endpoints_platform_admin ON public.geo_provider_endpoints
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
CREATE POLICY geo_provider_statuses_read_all ON public.geo_provider_statuses
  FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY geo_provider_statuses_platform_admin ON public.geo_provider_statuses
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

-- The API writes, counts and purges the log as the system role (GeoCallLog,
-- the purge job), never as the requesting user: a member or tenant admin can
-- neither read the platform's provider costs nor forge or erase a row.
CREATE POLICY geo_provider_calls_system_insert ON public.geo_provider_calls
  FOR INSERT WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY geo_provider_calls_system_purge ON public.geo_provider_calls
  FOR DELETE USING ((SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY geo_provider_calls_platform_read ON public.geo_provider_calls
  FOR SELECT USING ((SELECT public.app_is_platform()) OR (SELECT public.app_is_system()));
--> statement-breakpoint
CREATE POLICY geo_provider_calls_platform_admin ON public.geo_provider_calls
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint

GRANT SELECT ON public.geo_provider_endpoints, public.geo_provider_statuses TO ae_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.geo_provider_calls TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Notifications and the purge job
-- ============================================================================

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('geo_budget_warning',   'enum.notification_types.geo_budget_warning',   200),
  ('geo_budget_exhausted', 'enum.notification_types.geo_budget_exhausted', 210);
--> statement-breakpoint
INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('purge-geo-provider-calls', 'enum.scheduled_jobs.purge-geo-provider-calls', 100);
--> statement-breakpoint

-- ============================================================================
-- Settings
-- ============================================================================

-- What 0021 seeded and this layer replaces (only these two rows; no column).
DELETE FROM public.platform_settings
  WHERE key IN ('geocode_cache_days', 'geocode_reverse_cache_decimals');
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('geo_provider', '"barikoi"', 'text', NULL, NULL, NULL, 'none',
   'Geo provider: barikoi, or null (never call any provider; geocoding answers from our own data).'),
  ('barikoi_daily_call_budget', '1000', 'integer', 'calls', 0, 1000000, 'none',
   'Barikoi calls (as Barikoi bills them, not requests) the platform may spend per day (Asia/Dhaka). At 100%: our own data only until midnight. 0 = never call Barikoi.'),
  ('barikoi_budget_warn_pct', '80', 'integer', 'percent', 1, 100, 'none',
   'Share of the daily Barikoi budget at which platform admins get one alert for the day.'),
  ('barikoi_cost_autocomplete', '1', 'integer', 'calls', 0, 20, 'none',
   'Barikoi calls one autocomplete request costs.'),
  ('barikoi_cost_reverse_base', '1', 'integer', 'calls', 0, 20, 'none',
   'Barikoi calls a reverse geocode costs before optional fields (its base answer has the English address, area and city).'),
  ('barikoi_cost_reverse_per_field', '1', 'integer', 'calls', 0, 20, 'none',
   'Barikoi calls each optional reverse-geocode field (bangla, post_code, district…) adds.'),
  ('barikoi_cost_rupantor', '2', 'integer', 'calls', 0, 20, 'none',
   'Barikoi calls one Rupantor address geocode costs (bulk/agent use only).'),
  ('barikoi_cost_route', '2', 'integer', 'calls', 0, 20, 'none',
   'Barikoi calls one route request costs.'),
  ('geo_cache_ttl_hours', '24', 'integer', 'hours', 1, 8760, 'none',
   'How long any provider answer is reused from the cache. Conservative until Barikoi''s terms on caching are confirmed.'),
  ('reverse_geocode_cache_precision', '7', 'integer', 'geohash chars', 5, 9, 'none',
   'Reverse-geocode answers are cached per geohash cell of this length (7 ≈ 150 m, about a block), so nearby pins share one paid call.'),
  ('geo_reverse_fields_post_location', '["bangla"]', 'text_array', NULL, NULL, NULL, 'none',
   'Optional Barikoi reverse fields asked for when a post''s pin is placed (each costs barikoi_cost_reverse_per_field).'),
  ('geo_reverse_fields_store_setup', '["bangla", "post_code"]', 'text_array', NULL, NULL, NULL, 'none',
   'Optional Barikoi reverse fields asked for when a store is set up.'),
  ('geo_reverse_fields_place_marking', '["bangla"]', 'text_array', NULL, NULL, NULL, 'none',
   'Optional Barikoi reverse fields asked for when a place is marked on the map.'),
  ('geo_own_results_min', '3', 'integer', 'count', 1, 20, 'none',
   'Autocomplete: when our own places, landmarks, stores and areas give at least this many matches, Barikoi is not asked.'),
  ('geo_own_radius_km', '30', 'decimal', 'km', 1, 300, 'none',
   'How far from the user our own places, landmarks and stores are searched for autocomplete.'),
  ('geo_autocomplete_per_client_per_minute', '60', 'integer', 'count', 1, 1000, 'none',
   'Autocomplete requests one client (user, else IP) may make per minute; clients also debounce.'),
  ('geo_breaker_cooldown_seconds', '60', 'integer', 'seconds', 5, 3600, 'none',
   'After a provider timeout or 429, how long our own data answers without trying the provider.'),
  ('geo_provider_calls_retention_days', '90', 'integer', 'days', 7, 730, 'none',
   'geo_provider_calls rows older than this are purged (purge-geo-provider-calls job).'),
  ('geo_usage_report_days_max', '90', 'integer', 'days', 1, 365, 'none',
   'Longest window GET /analytics/geo-usage reports.'),
  ('route_point_decimals', '4', 'integer', 'decimals', 2, 6, 'none',
   'Route endpoints are rounded to this many decimals (4 ≈ 11 m) for the route cache.'),
  ('route_requests_per_client_per_hour', '30', 'integer', 'count', 1, 1000, 'none',
   'Route requests one client (user, else IP) may make per hour; routes are paid calls asked for by an explicit tap.'),
  ('map_cluster_cell_px', '64', 'integer', 'pixels', 16, 256, 'none',
   'Map clustering grid: points within one cell of this many screen pixels at the current zoom become one cluster. Cells divide a 256 px tile evenly (rounded), so clusters are the same whatever the viewport.'),
  ('map_cluster_until_zoom', '16', 'integer', 'zoom', 10, 22, 'none',
   'Below this zoom the map is clustered on the server; from it on, every feature is shown on its own.'),
  ('map_viewport_max_radius_km', '25', 'decimal', 'km', 1, 200, 'none',
   'A map viewport only shows features within this distance of its centre (discovery is radius-based); zoom in to see beyond.'),
  ('map_features_max', '500', 'integer', 'count', 50, 5000, 'none',
   'Most features (clusters and points) one GET /map/features request returns; the biggest clusters, then the nearest points, first.'),
  ('map_features_cache_seconds', '60', 'integer', 'seconds', 5, 3600, 'none',
   'How long one (layers, filters, zoom, tile-aligned bbox) answer of GET /map/features is reused from Redis.'),
  ('map_layers_default', '["posts", "stores", "places", "landmarks", "info"]', 'text_array', NULL, NULL, NULL, 'none',
   'Map layers shown when a request names none.');
--> statement-breakpoint


-- ============================================================================
-- map_features
-- ============================================================================

-- The map's data for a box (ADR 045): public-state features of the asked
-- layers, from our own tables only.
--
--   posts      live posts (not sold, hidden or deleted)
--   stores     active stores
--   places     published / temporarily closed places that are not landmarks
--   landmarks  the same, landmarks
--   info       active emergency services with a location (hospital,
--              pharmacy_24h, police, ambulance…) and the stops of active
--              transport routes (bus stands)
--
-- Clustering: a Web Mercator grid of map_cluster_cell_px-pixel cells at
-- p_zoom, rounded so a whole number of cells fills a 256 px tile — cells
-- line up with tiles, so a cell's cluster is the same in every viewport
-- (and cacheable per tile-aligned box). Each layer clusters on its own.
-- From map_cluster_until_zoom on, every feature is its own row. A cell of
-- one feature returns that feature in full; a bigger cell its count and
-- centre.
--
-- Radius-based (CLAUDE.md rule 10). With p_center, only features within
-- map_viewport_max_radius_km of it are returned. Without it the box itself
-- must lie within that radius of its own centre (the caller asked for a
-- small, tile-aligned box) — never a tenant filter, never an unbounded scan.
--
-- p_category_slug: that category and its active descendants (posts, places,
-- landmarks; stores and info have no category, so they drop out).
-- p_open_now: places/landmarks open now by place_hours (Asia/Dhaka), info
-- that is open around the clock (24h emergency services, bus stops); posts
-- and stores have no hours, so they drop out.
--
-- SECURITY DEFINER like discover_nearby (0023), but it returns display
-- columns too — only what each table's public-read policy already shows to
-- anyone, for public-state rows — so one query serves 5,000 points fast.
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
  IF max_radius_km IS NULL OR cell_px_setting IS NULL OR until_zoom IS NULL OR max_items IS NULL THEN
    RAISE EXCEPTION 'platform settings map_viewport_max_radius_km / map_cluster_cell_px / map_cluster_until_zoom / map_features_max are missing';
  END IF;

  radius_m := max_radius_km * 1000;
  envelope := st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326);
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

  local_now := now() AT TIME ZONE 'Asia/Dhaka';
  local_dow := extract(isodow FROM local_now)::smallint;
  local_time := local_now::time;

  RETURN QUERY
    WITH pts AS (
      SELECT 'posts'::text AS layer, p.id, p.tenant_id, p.location::geometry AS g,
             -- A post has one title: it is the Bengali name when written in Bengali.
             CASE WHEN p.title ~ '[ঀ-৿]' THEN p.title END AS name_bn,
             CASE WHEN p.title ~ '[ঀ-৿]' THEN NULL ELSE p.title END AS name_en,
             pc.slug AS category_slug, p.price::text AS price, NULL::text AS slug,
             NULL::text AS info_kind, NULL::boolean AS open_now
      FROM public.posts p
      JOIN public.categories pc ON pc.id = p.category_id
      WHERE 'posts' = ANY (p_layers)
        AND NOT coalesce(p_open_now, false)
        -- Matches posts_location_gist_idx's predicate, so the index is used.
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
        AND p.location::geometry && envelope
        AND (box_fits OR st_dwithin(p.location, center, radius_m))
        AND (category_ids IS NULL OR p.category_id = ANY (category_ids))
      UNION ALL
      SELECT 'stores'::text, s.id, s.tenant_id, s.location::geometry,
             s.name_bn, s.name_en, NULL::text, NULL::text, s.slug, NULL::text, NULL::boolean
      FROM public.stores s
      WHERE 'stores' = ANY (p_layers)
        AND p_category_slug IS NULL AND NOT coalesce(p_open_now, false)
        AND s.status_code = 'active' AND s.deleted_at IS NULL AND s.location IS NOT NULL
        AND s.location::geometry && envelope
        AND (box_fits OR st_dwithin(s.location, center, radius_m))
      UNION ALL
      SELECT CASE WHEN pl.is_landmark THEN 'landmarks' ELSE 'places' END::text,
             pl.id, pl.tenant_id, pl.location::geometry,
             pl.name_bn, pl.name_en, plc.slug, NULL::text, pl.slug, NULL::text, o.open_now
      FROM public.places pl
      JOIN public.categories plc ON plc.id = pl.category_id
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN pl.status_code = 'temporarily_closed' THEN false
                 WHEN NOT EXISTS (SELECT 1 FROM public.place_hours h WHERE h.place_id = pl.id) THEN NULL
                 ELSE EXISTS (
                   SELECT 1 FROM public.place_hours h
                   WHERE h.place_id = pl.id AND (
                     (h.iso_day_of_week = local_dow AND h.opens_at <= local_time
                       AND (h.closes_next_day OR local_time < h.closes_at))
                     OR (h.closes_next_day AND local_time < h.closes_at
                       AND h.iso_day_of_week = CASE WHEN local_dow = 1 THEN 7 ELSE local_dow - 1 END)))
               END AS open_now
      ) o
      WHERE ((pl.is_landmark AND 'landmarks' = ANY (p_layers))
             OR (NOT pl.is_landmark AND 'places' = ANY (p_layers)))
        AND pl.status_code IN ('published', 'temporarily_closed') AND pl.deleted_at IS NULL
        AND pl.location::geometry && envelope
        AND (box_fits OR st_dwithin(pl.location, center, radius_m))
        AND (category_ids IS NULL OR pl.category_id = ANY (category_ids))
        AND (NOT coalesce(p_open_now, false) OR o.open_now)
      UNION ALL
      SELECT 'info'::text, e.id, e.tenant_id, e.location::geometry,
             e.name_bn, e.name_en, NULL::text, NULL::text, NULL::text, e.service_type_code,
             CASE WHEN e.is_24h THEN true END
      FROM public.emergency_contacts e
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND e.is_active AND e.deleted_at IS NULL AND e.location IS NOT NULL
        AND e.location::geometry && envelope
        AND (box_fits OR st_dwithin(e.location, center, radius_m))
        AND (NOT coalesce(p_open_now, false) OR e.is_24h)
      UNION ALL
      SELECT 'info'::text, st.id, st.tenant_id, st.location::geometry,
             st.name_bn, st.name_en, NULL::text, NULL::text, NULL::text, 'bus_stop'::text, true
      FROM public.transport_route_stops st
      JOIN public.transport_routes r ON r.tenant_id = st.tenant_id AND r.id = st.transport_route_id
      WHERE 'info' = ANY (p_layers)
        AND p_category_slug IS NULL
        AND r.is_active AND r.deleted_at IS NULL AND st.location IS NOT NULL
        AND st.location::geometry && envelope
        AND (box_fits OR st_dwithin(st.location, center, radius_m))
    ),
    -- Below until_zoom: cells keyed on the Web Mercator pixel grid.
    -- (the slippy-map formulas: x from longitude, y from the Mercator
    -- latitude, in world pixels at p_zoom, then whole cells).
    keyed AS (
      SELECT pts.*,
             floor((st_x(pts.g) + 180) / 360 * world_px / cell_px) AS cx,
             floor((0.5 - ln(tan(pi() / 4 + radians(least(85.0511287798066, greatest(-85.0511287798066, st_y(pts.g)))) / 2)) / (2 * pi()))
                   * world_px / cell_px) AS cy
      FROM pts
      WHERE cluster
    ),
    -- A cell of one is that feature in full (max() of one row is that row);
    -- a bigger cell is its count and centre.
    cells AS (
      SELECT k.layer, count(*)::integer AS n, avg(st_x(k.g)) AS lng, avg(st_y(k.g)) AS lat,
             CASE WHEN count(*) = 1 THEN max(k.id::text)::uuid END AS id,
             CASE WHEN count(*) = 1 THEN max(k.tenant_id::text)::uuid END AS tenant_id,
             CASE WHEN count(*) = 1 THEN max(k.name_bn) END AS name_bn,
             CASE WHEN count(*) = 1 THEN max(k.name_en) END AS name_en,
             CASE WHEN count(*) = 1 THEN max(k.category_slug) END AS category_slug,
             CASE WHEN count(*) = 1 THEN max(k.price) END AS price,
             CASE WHEN count(*) = 1 THEN max(k.slug) END AS slug,
             CASE WHEN count(*) = 1 THEN max(k.info_kind) END AS info_kind,
             CASE WHEN count(*) = 1 THEN bool_or(k.open_now) END AS open_now
      FROM keyed k
      GROUP BY k.layer, k.cx, k.cy
    ),
    -- From until_zoom every feature is its own row.
    rows AS (
      SELECT * FROM cells
      UNION ALL
      SELECT pts.layer, 1, st_x(pts.g), st_y(pts.g), pts.id, pts.tenant_id, pts.name_bn,
             pts.name_en, pts.category_slug, pts.price, pts.slug, pts.info_kind, pts.open_now
      FROM pts
      WHERE NOT cluster
    )
    SELECT r.layer, r.n, r.lng, r.lat, r.id, r.tenant_id, r.name_bn, r.name_en,
           r.category_slug, r.price, r.slug, r.info_kind, r.open_now
    FROM rows r
    ORDER BY r.n DESC,
             (r.lng - center_lng) ^ 2 * lng_scale + (r.lat - center_lat) ^ 2,
             r.layer, r.id
    LIMIT least(p_limit, max_items + 1);
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer) IS
  'The map''s data (ADR 045): public-state posts/stores/places/landmarks/info in a box, radius-bounded, grid-clustered by zoom, with names in both languages. SECURITY DEFINER: only columns public-read already exposes.';
--> statement-breakpoint
ALTER FUNCTION public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer)
  OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.map_features(double precision, double precision, double precision, double precision, integer, text[], text, boolean, double precision, double precision, integer)
TO ae_app;
--> statement-breakpoint

-- BYPASSRLS skips row policies, not table GRANTs (0012 precedent): what
-- map_features reads beyond 0012/0023/0030's grants.
GRANT SELECT ON public.place_hours, public.emergency_contacts,
  public.transport_routes, public.transport_route_stops TO ae_rls_bypass;

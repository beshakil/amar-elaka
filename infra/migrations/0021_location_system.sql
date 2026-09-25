-- 0021_location_system
--
-- The location system (ADR 026):
--
--   1. geo_areas.cod_pcode: the HDX COD-AB pcode (BD, BD30, BD3026,
--      BD30260014, BD45619413), the join key of the real Bangladesh data in
--      infra/geo/reference/. ⚠ FLAG: geo_areas_bbs_code_ck is REPLACED (not
--      dropped) so that a row may be identified by its COD-AB pcode alone —
--      the 2023 release no longer carries the 2011/2015 BBS geocode columns.
--      No column is dropped or renamed; existing rows still satisfy it.
--   2. Tenant boundary, two modes (tenants.boundary_mode):
--        polygon — the tenant's geo_areas.boundary (an upazila, verified area);
--        radius  — map_center + service_radius_km, for places with no
--                  authoritative polygon (metro thanas, new towns).
--   3. PostGIS helpers used by the API and by other SQL:
--        geo_point, geo_distance_m, geo_bbox,
--        tenant_covers_point, tenant_distance_m, nearest_tenants,
--        geo_areas_in_bbox.
--      All are SECURITY INVOKER: they read tenants / geo_areas through the
--      caller's RLS (both are publicly readable except archived tenants).
--   4. Settings (CLAUDE.md rule 9): geocoding cache and limits, viewport cap,
--      service-radius cap.

-- ============================================================================
-- geo_areas: COD-AB pcode
-- ============================================================================

ALTER TABLE public.geo_areas ADD COLUMN cod_pcode text;
--> statement-breakpoint
ALTER TABLE public.geo_areas
  ADD CONSTRAINT geo_areas_cod_pcode_ck CHECK (cod_pcode IS NULL OR cod_pcode ~ '^BD[0-9]*$');
--> statement-breakpoint
-- Idempotent upsert by pcode on re-import (geo:import).
CREATE UNIQUE INDEX geo_areas_cod_pcode_uq ON public.geo_areas (cod_pcode)
  WHERE cod_pcode IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.geo_areas DROP CONSTRAINT geo_areas_bbs_code_ck;
--> statement-breakpoint
ALTER TABLE public.geo_areas
  ADD CONSTRAINT geo_areas_bbs_code_ck
  CHECK (adm_level = 0 OR num_nonnulls(bbs_code_geocode11, bbs_code_geocode15, cod_pcode) >= 1);
--> statement-breakpoint
-- Cascading pickers list active children by name.
CREATE INDEX geo_areas_parent_active_name_idx ON public.geo_areas (parent_id, name_en)
  WHERE is_active;
--> statement-breakpoint

-- ============================================================================
-- tenants: polygon or center + radius
-- ============================================================================

ALTER TABLE public.tenants
  ADD COLUMN boundary_mode text NOT NULL DEFAULT 'polygon',
  ADD COLUMN service_radius_km numeric(6,2);
--> statement-breakpoint
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_boundary_mode_ck CHECK (boundary_mode IN ('polygon', 'radius')),
  ADD CONSTRAINT tenants_service_radius_ck CHECK (
    (boundary_mode = 'radius') = (service_radius_km IS NOT NULL)
    AND (service_radius_km IS NULL OR service_radius_km > 0)
  );
--> statement-breakpoint

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('geocode_cache_days', '30', 'integer', 'days', 1, 365, 'none',
   'How long geocoding answers (forward, reverse, autocomplete) are cached. Addresses rarely change; provider calls cost money.'),
  ('geocode_results_max', '8', 'integer', 'count', 1, 20, 'none',
   'Most results a forward-geocode or autocomplete request returns.'),
  ('geocode_autocomplete_min_chars', '3', 'integer', 'chars', 1, 10, 'none',
   'Characters typed before address autocomplete calls the provider.'),
  ('geocode_reverse_cache_decimals', '4', 'integer', 'count', 3, 6, 'none',
   'Decimal places a reverse-geocode point is rounded to for its cache key (4 ≈ 11 m).'),
  ('map_viewport_max_areas', '500', 'integer', 'count', 10, 5000, 'none',
   'Most areas one map-viewport request returns.'),
  ('tenant_service_radius_max_km', '50', 'decimal', 'km', 1, 200, 'none',
   'Largest service radius a center+radius tenant may have.');
--> statement-breakpoint

-- ============================================================================
-- Helpers
-- ============================================================================

-- Latitude first, as people say it; PostGIS points are (lng, lat).
CREATE OR REPLACE FUNCTION public.geo_point(p_lat double precision, p_lng double precision)
RETURNS geography
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.geo_point(double precision, double precision) IS
  'A WGS84 geography point from (lat, lng) — note the order.';
--> statement-breakpoint

-- Geodesic distance on the WGS84 spheroid, in metres (not a planar/degree distance).
CREATE OR REPLACE FUNCTION public.geo_distance_m(p_a geography, p_b geography)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT st_distance(p_a, p_b, true)
$$;
--> statement-breakpoint

-- Map viewport: an envelope usable with && / ST_Intersects on any geography column.
CREATE OR REPLACE FUNCTION public.geo_bbox(
  p_min_lng double precision, p_min_lat double precision,
  p_max_lng double precision, p_max_lat double precision
)
RETURNS geography
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)::geography
$$;
--> statement-breakpoint

-- Distance from a point to a tenant's area, in metres: 0 when the point is
-- inside. Polygon mode measures to the border of the full-precision boundary;
-- radius mode to the edge of the circle. A polygon-mode tenant whose area has
-- no boundary yet falls back to the distance to its map_center (never "inside").
CREATE OR REPLACE FUNCTION public.tenant_distance_m(p_tenant_id uuid, p_point geography)
RETURNS double precision
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN t.boundary_mode = 'radius'
      THEN greatest(0, st_distance(t.map_center, p_point) - t.service_radius_km * 1000)
    WHEN ga.boundary IS NOT NULL
      THEN st_distance(ga.boundary, p_point)
    ELSE greatest(st_distance(t.map_center, p_point), 1e-9) -- a centre is not an area
  END
  FROM public.tenants t
  LEFT JOIN public.geo_areas ga ON ga.id = t.geo_area_id
  WHERE t.id = p_tenant_id
$$;
--> statement-breakpoint

-- Point-in-tenant.
CREATE OR REPLACE FUNCTION public.tenant_covers_point(p_tenant_id uuid, p_point geography)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN t.boundary_mode = 'radius'
      THEN st_dwithin(t.map_center, p_point, t.service_radius_km * 1000)
    WHEN ga.boundary IS NOT NULL
      THEN st_covers(ga.boundary, p_point)
    ELSE false
  END
  FROM public.tenants t
  LEFT JOIN public.geo_areas ga ON ga.id = t.geo_area_id
  WHERE t.id = p_tenant_id
$$;
--> statement-breakpoint

-- Live tenants near a point, best first: a tenant whose area contains the
-- point beats any that doesn't; then the smallest distance to the area; ties
-- (overlapping radius tenants) go to the nearest centre. Candidates are
-- prefiltered with ST_DWithin so the GiST indexes on boundary and map_center
-- do the work.
CREATE OR REPLACE FUNCTION public.nearest_tenants(
  p_point geography,
  p_max_distance_m double precision,
  p_limit integer DEFAULT 1
)
RETURNS TABLE (tenant_id uuid, inside boolean, distance_m double precision)
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.distance_m = 0, c.distance_m
  FROM (
    SELECT t.id, st_distance(t.map_center, p_point) AS center_m,
      CASE
        WHEN t.boundary_mode = 'radius'
          THEN greatest(0, st_distance(t.map_center, p_point) - t.service_radius_km * 1000)
        WHEN ga.boundary IS NOT NULL THEN st_distance(ga.boundary, p_point)
        ELSE greatest(st_distance(t.map_center, p_point), 1e-9)
      END AS distance_m
    FROM public.tenants t
    LEFT JOIN public.geo_areas ga ON ga.id = t.geo_area_id
    WHERE t.status_code IN ('active', 'past_due')
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

-- Areas visible in a map viewport, for drawing: simplified boundary (never
-- the full-precision one), or the centre for areas that only have a point.
CREATE OR REPLACE FUNCTION public.geo_areas_in_bbox(
  p_min_lng double precision, p_min_lat double precision,
  p_max_lng double precision, p_max_lat double precision,
  p_level_code text,
  p_limit integer
)
RETURNS TABLE (
  id uuid, parent_id uuid, level_code text, cod_pcode text,
  name_en text, name_bn text, centroid geography, boundary_simplified geography
)
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT g.id, g.parent_id, g.level_code, g.cod_pcode, g.name_en, g.name_bn,
         g.centroid, g.boundary_simplified
  FROM public.geo_areas g
  WHERE g.is_active
    AND g.level_code = p_level_code
    AND coalesce(g.boundary_simplified, g.centroid)
        && public.geo_bbox(p_min_lng, p_min_lat, p_max_lng, p_max_lat)
  ORDER BY g.name_en, g.id
  LIMIT p_limit
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  public.geo_point(double precision, double precision),
  public.geo_distance_m(geography, geography),
  public.geo_bbox(double precision, double precision, double precision, double precision),
  public.tenant_distance_m(uuid, geography),
  public.tenant_covers_point(uuid, geography),
  public.nearest_tenants(geography, double precision, integer),
  public.geo_areas_in_bbox(double precision, double precision, double precision, double precision, text, integer)
TO ae_app;

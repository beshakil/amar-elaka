-- 0045_offline_maps_and_heatmap
--
-- Two features (ADR 050):
--
-- 1. Offline map area (the app). A worker job cuts each tenant's part of the
--    national bd-<version>.pmtiles with `pmtiles extract --bbox` (tenant
--    boundary + offline_map_buffer_km, max zoom offline_map_max_zoom, stepped
--    down until the file fits offline_map_max_mb) into
--    tiles/tenants/<tenant>-<version>.pmtiles, and again whenever the national
--    file is refreshed. Zero Barikoi cost: our own tiles, glyphs and sprites.
--
--      offline_map_files   TENANT-SCOPED, one row per (tenant, national
--                          version): the file, its size and checksum, the
--                          zoom it got, its bounds — or why it couldn't be
--                          built (too_large, failed). Read by anyone in the
--                          tenant (GET /map/offline); written by the system.
--
-- 2. Demand/supply heatmap (admin, read-only).
--
--      heatmap_cells()     SECURITY DEFINER, tenant admins and platform staff
--                          only: demand (searches with a location in the last
--                          heatmap_window_days, active saved searches) or
--                          supply (live posts, active stores) of the current
--                          tenant, counted per geohash cell. Only cells with
--                          at least heatmap_min_cell_count DISTINCT people
--                          come back, so no cell can point at one person; a
--                          point is never returned, only a cell's centre.
--
-- Seeds: settings, the job code. Tests: apps/api/test/offline-map.db-spec.ts,
-- apps/api/test/heatmap.db-spec.ts, apps/api/test/offline-map.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('build-offline-maps', 'enum.scheduled_jobs.build-offline-maps', 120);
--> statement-breakpoint

-- ============================================================================
-- offline_map_files
-- ============================================================================

CREATE TABLE public.offline_map_files (
  id                uuid         NOT NULL DEFAULT public.uuid_generate_v7(),
  tenant_id         uuid         NOT NULL DEFAULT public.current_tenant_id(),
  -- The national archive it was cut from (current.json `version`).
  national_version  text         NOT NULL,
  status_code       text         NOT NULL,
  -- tenants/<tenant id>-<national version>.pmtiles, under the tiles root.
  file_name         text,
  bytes             bigint,
  sha256            text,
  max_zoom          smallint,
  min_lng           numeric(9,6),
  min_lat           numeric(9,6),
  max_lng           numeric(9,6),
  max_lat           numeric(9,6),
  error             text,
  built_at          timestamptz  NOT NULL DEFAULT now(),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT offline_map_files_pk PRIMARY KEY (id),
  CONSTRAINT offline_map_files_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE CASCADE,
  CONSTRAINT offline_map_files_status_ck CHECK (status_code IN ('ready', 'too_large', 'failed')),
  CONSTRAINT offline_map_files_version_ck CHECK (national_version ~ '^[A-Za-z0-9._-]+$'),
  CONSTRAINT offline_map_files_ready_ck CHECK (
    status_code <> 'ready' OR (
      file_name IS NOT NULL AND bytes > 0 AND sha256 ~ '^[0-9a-f]{64}$' AND max_zoom BETWEEN 0 AND 15
      AND min_lng < max_lng AND min_lat < max_lat)
  ),
  CONSTRAINT offline_map_files_file_name_ck CHECK (file_name IS NULL OR file_name ~ '^tenants/[a-z0-9-]+\.pmtiles$')
);
--> statement-breakpoint
-- One attempt per tenant per national version; a retry replaces it.
CREATE UNIQUE INDEX offline_map_files_tenant_version_uq ON public.offline_map_files (tenant_id, national_version);
--> statement-breakpoint
-- The newest ready file of a tenant.
CREATE INDEX offline_map_files_tenant_ready_idx ON public.offline_map_files (tenant_id, built_at DESC)
  WHERE status_code = 'ready';
--> statement-breakpoint
CREATE TRIGGER offline_map_files_set_updated_at BEFORE UPDATE ON public.offline_map_files
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
ALTER TABLE public.offline_map_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.offline_map_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Public facts (a file anyone may download): readable in its tenant's context.
CREATE POLICY offline_map_files_read ON public.offline_map_files
  FOR SELECT USING (tenant_id = (SELECT public.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY offline_map_files_system ON public.offline_map_files
  FOR ALL
  USING ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()))
  WITH CHECK ((SELECT public.app_is_system()) OR (SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.offline_map_files TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings (rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('offline_map_max_mb', '50', 'integer', 'MB', 1, 500, 'platform',
   'Largest offline map file a tenant gets. The build steps the zoom down until the file fits.'),
  ('offline_map_max_zoom', '14', 'integer', 'zoom', 8, 15, 'platform',
   'Deepest zoom an offline map holds (never deeper than the national archive). MapLibre overzooms past it.'),
  ('offline_map_min_zoom', '11', 'integer', 'zoom', 6, 15, 'none',
   'The build never steps below this zoom to make a file fit: a smaller file than that is useless, so the tenant gets none.'),
  ('offline_map_buffer_km', '2', 'decimal', 'km', 0, 50, 'platform',
   'Margin around the tenant boundary that the offline map also covers (roads just across the line).'),
  ('offline_map_glyph_ranges', '["0-255", "256-511", "2304-2559", "8192-8447", "8448-8703"]', 'text_array',
   NULL, NULL, NULL, 'none',
   'Glyph ranges of each font stack the offline bundle carries: Latin, Latin extended, Bengali, punctuation and symbols.'),
  ('offline_map_point_sets', '[
    {"layers": ["info", "places"], "kinds": ["hospital", "pharmacy"]},
    {"layers": ["info"]},
    {"layers": ["landmarks"]}
  ]', 'json', NULL, NULL, NULL, 'none',
   'The /map/features queries whose points the app keeps offline (emergency services, hospitals, pharmacies, landmarks).'),
  ('offline_map_update_check_hours', '24', 'integer', 'hours', 1, 720, 'none',
   'How often the app checks for a newer offline map (and, on Wi-Fi when allowed, downloads it).'),
  ('offline_map_area_simplify_m', '25', 'decimal', 'meters', 0, 500, 'none',
   'Simplification tolerance of the area outlines kept offline (the picker''s area name without a network).'),
  ('heatmap_min_cell_count', '5', 'integer', 'count', 2, 1000, 'platform',
   'A heatmap cell is shown only when this many different people are behind it, so no cell can reveal one person.'),
  ('heatmap_window_days', '30', 'integer', 'days', 1, 365, 'none',
   'How far back the demand heatmap counts searches.'),
  ('heatmap_geohash_precision', '6', 'integer', 'characters', 4, 7, 'none',
   'Heatmap grid: geohash length (6 ≈ 1.2 × 0.6 km cells).'),
  ('heatmap_cells_max', '3000', 'integer', 'count', 100, 20000, 'none',
   'Most cells one heatmap response carries (the densest first).');
--> statement-breakpoint

-- ============================================================================
-- heatmap_cells (owned by ae_rls_bypass)
-- ============================================================================

SET LOCAL ROLE ae_rls_bypass;
--> statement-breakpoint

-- Demand or supply of the current tenant per geohash cell (ADR 050).
--   demand  search_queries with an origin (already rounded when logged, 0035)
--           in the last p_window_days, plus active saved searches centred in
--           the tenant's area (they belong to users, not tenants);
--           a person = the signed-in user, else the searcher hash.
--   supply  live posts (by author) and active stores (by owner; at their
--           place when they have no point of their own).
-- p_category_slug narrows to that category and its descendants (stores have
-- no category: none for a category heatmap). Only cells with >= p_min_people
-- distinct people; `count` is the events (searches, listings) behind them.
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
  v_boundary geography;
BEGIN
  IF v_tenant IS NULL OR NOT (public.app_is_tenant_admin() OR public.app_is_platform()) THEN
    RAISE EXCEPTION 'heatmap_cells: tenant admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type NOT IN ('demand', 'supply') OR p_precision IS NULL OR p_precision < 1 OR p_precision > 12
     OR p_min_people IS NULL OR p_min_people < 2 OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'heatmap_cells: bad arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT coalesce(g.boundary, g.boundary_simplified) INTO v_boundary
  FROM public.tenants t JOIN public.geo_areas g ON g.id = t.geo_area_id WHERE t.id = v_tenant;
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
      -- ones centred inside its area (the boundary decides ownership).
      SELECT ss.center::geometry, ss.user_id::text
      FROM public.saved_searches ss
      WHERE p_type = 'demand' AND v_boundary IS NOT NULL AND st_covers(v_boundary, ss.center)
        AND ss.is_active AND ss.paused_at IS NULL AND ss.deleted_at IS NULL
        AND (v_categories IS NULL OR ss.category_id = ANY (v_categories))
      UNION ALL
      SELECT p.location::geometry, p.author_member_id::text
      FROM public.posts p
      WHERE p_type = 'supply' AND p.tenant_id = v_tenant
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
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

ALTER FUNCTION public.heatmap_cells(text, text, integer, integer, integer, integer) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.heatmap_cells(text, text, integer, integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.heatmap_cells(text, text, integer, integer, integer, integer) TO ae_app;
--> statement-breakpoint
GRANT SELECT ON public.search_queries, public.saved_searches, public.geo_areas TO ae_rls_bypass;

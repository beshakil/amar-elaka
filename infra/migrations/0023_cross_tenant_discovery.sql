-- 0023_cross_tenant_discovery
--
-- Boundaries decide ownership, never discovery (schema.md §13.26, §13.5):
--
--   resolve_owning_tenant(point, fallback_tenant_id)
--     Which tenant owns a new post/place at this point. Must see every
--     tenant's boundary and per-tenant boundary_buffer_km override before any
--     tenant context exists for the write, so it reads tenant_settings across
--     tenants. Returns (tenant_id, resolution_code) only.
--
--   discover_nearby(point, radius_km, kinds, category_ids, limit, offset)
--     The Postgres path of pure-radius discovery: public-state posts, stores
--     and places within the radius, whichever tenant owns them. Returns
--     (entity, id, tenant_id, distance_m) only; callers read each row's
--     details in its owning tenant's context, so T-PUBLIC-READ and the
--     isolation tests stay exactly as they are — nobody gets cross-tenant
--     SELECT on these tables.
--
-- Both are SECURITY DEFINER owned by ae_rls_bypass (0012 legal_hold_blocks
-- precedent), pin search_path, and read their bounds from platform_settings
-- (CLAUDE.md rule 9): discover_nearby clamps radius and page size to
-- search_max_radius_km / search_page_size_max, so no caller can turn it into
-- an unbounded cross-tenant scan. A missing setting raises rather than
-- guessing, like SettingsService.
--
-- No table changes. Tests: apps/api/test/cross-tenant-discovery.db-spec.ts.

-- ============================================================================
-- resolve_owning_tenant
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_owning_tenant(
  p_point geography,
  p_fallback_tenant_id uuid
)
RETURNS TABLE (tenant_id uuid, resolution_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  platform_buffer_km numeric;
  widest_buffer_km numeric;
BEGIN
  IF p_point IS NULL THEN
    RETURN QUERY SELECT p_fallback_tenant_id, 'no_location'::text;
    RETURN;
  END IF;

  SELECT (ps.value #>> '{}')::numeric INTO platform_buffer_km
  FROM public.platform_settings ps
  WHERE ps.key = 'boundary_buffer_km';
  IF platform_buffer_km IS NULL THEN
    RAISE EXCEPTION 'platform setting boundary_buffer_km is missing';
  END IF;

  -- Widest buffer any tenant may have: the candidate search radius.
  SELECT greatest(platform_buffer_km,
                  coalesce(max((ts.setting_overrides ->> 'boundary_buffer_km')::numeric), 0))
    INTO widest_buffer_km
  FROM public.tenant_settings ts
  WHERE ts.setting_overrides ->> 'boundary_buffer_km' IS NOT NULL;

  -- nearest_tenants (0021) already ranks a containing tenant first, then by
  -- distance to the area (full-precision boundary, never the simplified one),
  -- then by nearest centre; WITH ORDINALITY keeps that order. Only
  -- active/past_due tenants are candidates. A NULL limit returns them all.
  RETURN QUERY
    SELECT n.tenant_id,
           CASE WHEN n.inside THEN 'inside_boundary' ELSE 'within_buffer' END::text
    FROM public.nearest_tenants(p_point, widest_buffer_km * 1000, NULL)
           WITH ORDINALITY AS n(tenant_id, inside, distance_m, rank)
    LEFT JOIN public.tenant_settings ts ON ts.tenant_id = n.tenant_id
    WHERE n.inside
       OR n.distance_m <= coalesce((ts.setting_overrides ->> 'boundary_buffer_km')::numeric,
                                   platform_buffer_km) * 1000
    ORDER BY n.rank
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT p_fallback_tenant_id, 'beyond_buffer_fallback'::text;
  END IF;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.resolve_owning_tenant(geography, uuid) IS
  'Owning tenant for a new post/place at a point (§13.26): inside_boundary, within_buffer (nearest), beyond_buffer_fallback (the fallback tenant; posts are forced to pending), or no_location. SECURITY DEFINER: must read every tenant''s buffer override.';
--> statement-breakpoint
ALTER FUNCTION public.resolve_owning_tenant(geography, uuid) OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_owning_tenant(geography, uuid) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- discover_nearby
-- ============================================================================

-- p_kinds: any of 'post', 'store', 'place'. p_category_ids: NULL for all
-- categories; stores have no category, so a category filter leaves them out.
-- Public state mirrors each table's public-read policy: live posts (not
-- sold — a sold post stays on its store page, not in discovery) that aren't
-- deleted or hidden; active stores; published / temporarily / permanently
-- closed places. Nearest first, ties by id, so paging is stable.
CREATE OR REPLACE FUNCTION public.discover_nearby(
  p_point geography,
  p_radius_km double precision,
  p_kinds text[],
  p_category_ids uuid[],
  p_limit integer,
  p_offset integer
)
RETURNS TABLE (entity text, id uuid, tenant_id uuid, distance_m double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
        -- Matches posts_location_gist_idx's predicate, so the index is used.
        AND p.status_code = 'live' AND p.deleted_at IS NULL AND NOT p.hidden_by_owner
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
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.discover_nearby(geography, double precision, text[], uuid[], integer, integer) IS
  'Pure-radius discovery across tenants (§13.26): ids of public-state posts/stores/places within the radius, nearest first. Radius and page size are clamped by platform settings. SECURITY DEFINER: returns ids only; details are read in each owner''s context.';
--> statement-breakpoint
ALTER FUNCTION public.discover_nearby(geography, double precision, text[], uuid[], integer, integer)
  OWNER TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.discover_nearby(geography, double precision, text[], uuid[], integer, integer)
TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Grants for the owner
-- ============================================================================

-- BYPASSRLS skips row policies but not table GRANTs (0012 precedent), so
-- ae_rls_bypass needs SELECT on everything these functions (and
-- nearest_tenants, which they call as their owner) read. posts and stores
-- were already granted in 0012.
GRANT SELECT ON public.places TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.tenants TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.geo_areas TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.tenant_settings TO ae_rls_bypass;
--> statement-breakpoint
GRANT SELECT ON public.platform_settings TO ae_rls_bypass;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.nearest_tenants(geography, double precision, integer) TO ae_rls_bypass;

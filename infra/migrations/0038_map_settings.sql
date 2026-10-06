-- 0038_map_settings
--
-- The self-hosted base map (ADR 043): Protomaps basemap tiles built from
-- OpenStreetMap, one Bangladesh .pmtiles file served from our own disk.
--
--   map_tiles_max_zoom    deepest zoom scripts/map/build-tiles.sh extracts.
--                         14 ≈ 200 MB, which Cloudflare can cache; 15 ≈ 560 MB,
--                         which it can't (512 MB per-file limit on non-Enterprise
--                         plans). 15 is the deepest zoom Protomaps publishes.
--                         Clients overzoom past it.
--   map_label_language    what map labels are written in: 'bn' (name:bn, else
--                         name) or 'en' (name:en, else name only when the
--                         renderer can shape its script, else no label).
--                         'en' until the Bengali shaping spike passes on a
--                         real Android phone and in Chrome (ADR 043): MapLibre
--                         draws Bengali glyph by glyph, so conjuncts may break.
--   map_style_fallback    an emergency replacement style.json URL, empty =
--                         disabled. It may point at a Barikoi style only in
--                         an emergency: EACH MAP LOAD COSTS 4 BARIKOI API
--                         CALLS (CLAUDE.md map rules).
--
-- No new table, so no new RLS. Seeds: the three settings.

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('map_tiles_max_zoom', '14', 'integer', 'zoom', 10, 15, 'none',
   'Deepest zoom level extracted into the self-hosted Bangladesh basemap file (scripts/map/build-tiles.sh). Above 14 the file outgrows Cloudflare''s cacheable size.'),
  ('map_label_language', '"en"', 'text', NULL, NULL, NULL, 'none',
   'Map label language: bn (Bengali names) or en (English names; Bengali-only names are hidden rather than drawn unshaped). Switch to bn only after the shaping spike passes (ADR 043).'),
  ('map_style_fallback', '""', 'text', NULL, NULL, NULL, 'none',
   'Emergency replacement map style.json URL; empty = disabled. A Barikoi style here costs 4 Barikoi API calls per map load.');

# ADR 050: Offline map area (mobile) and the demand/supply heatmap (admin)

**Status:** Accepted (2026-10-07).

**Code:**

- Migration: `0045_offline_maps_and_heatmap`
- API: `apps/api/src/map/offline/` (builder, worker job, `GET /map/offline`, `GET /map/offline/areas`);
  `apps/api/src/analytics/heatmap.service.ts` (`GET /analytics/heatmap`)
- Mobile: `apps/mobile/lib/features/offline_map/`; offline paths in `core/map/base_map.dart`,
  `core/map/location_picker.dart`, `features/map/presentation/map_screen.dart`
- Admin: `apps/admin/src/app/(dashboard)/heatmap/`
- Tests: API `test/offline-map.e2e-spec.ts`, `test/heatmap.db-spec.ts`, `test/heatmap.e2e-spec.ts`; mobile
  `test/features/offline_map/*`, the offline cases in `map_screen_test.dart` and `location_picker_test.dart`; admin
  `src/lib/map/heatmap.test.ts`

## Part 1: offline map area

### Context

Connections drop in exactly the moments a local map matters: in a hospital, during a storm, on a slow 2G
fallback. The base map is already ours (a national PMTiles file, ADR 043), so an offline area costs nothing per
use. In particular, Barikoi is never involved.

### Decision 1: one small file per tenant, cut on the server

- A worker job (`build-offline-maps`, hourly; queue `map`) runs `pmtiles extract --bbox` on the live national
  archive for each live tenant.
  - The box is the tenant boundary plus `offline_map_buffer_km`. Without a boundary, it is the map centre plus the
    buffer.
  - The file is written to `/tiles/tenants/<tenant id>-<national version>.pmtiles`, through a temp file and a rename.
- The job is idempotent: a tenant that already has a row for the live national version is skipped. When the
  national file is refreshed (a new `current.json` version), every tenant is rebuilt by the next run.
- Size cap:
  - The job starts at `offline_map_max_zoom` and steps down one zoom at a time, until the file fits
    `offline_map_max_mb` or `offline_map_min_zoom` is reached.
  - If it is still too large at the floor, the row is `too_large`; the file is deleted and the app says so.
- `offline_map_files` records each attempt: status, bytes, sha256, max zoom and bounds.
  - The latest two `ready` versions are kept, so a phone mid-download never loses its file; older ones are pruned
    from disk.
- The `pmtiles` CLI is pinned (go-pmtiles v1.31.2, sha256 checked) in the API image and in CI. It is called with
  `execFile` and an argument array, never a shell, with a timeout and retries (CLAUDE.md rule 5).
- Measured on real data at z14: Mirpur is about 1.9 MB and Trishal about 1.4 MB.

### Decision 2: the manifest is everything the phone needs

`GET /map/offline` (tenant required) returns:

- `archive`: url, bytes, sha256, version, maxZoom and bounds, or `available: false` with a `reason`.
- `assets`: the self-hosted glyph ranges (`offline_map_glyph_ranges`, per font stack), the Bengali font files and
  the sprites. Each has a path that mirrors the server layout, so the style's `{fontstack}/{range}` resolves
  unchanged against a local base.
- `totalBytes`, which the screen shows before anything downloads.
- `pointSets` (`offline_map_point_sets`): which `/map/features` layers and kinds to cache. The defaults are
  hospitals and pharmacies, emergency info and landmarks.
- `labelLanguage` and `updateCheckHours`, so the offline style needs no `/map/config`.

`GET /map/offline/areas` returns the tenant's area and the areas inside it, simplified by
`offline_map_area_simplify_m`, as GeoJSON.

### Decision 3: the phone

- **Download:** "এলাকার ম্যাপ ডাউনলোড" (Profile) shows the size first.
  - Every file goes to `staging-<version>/` and resumes with `Range` after a drop or a cancel.
  - Every file is verified by sha256; a mismatch deletes that file and reports it.
  - The point sets are cached in Drift (`offline_points`), and the area outlines and `map_kinds` are cached as JSON.
  - Only then is staging renamed and the Drift row (`offline_maps`) swapped, in one transaction. Until that moment
    the old version keeps working.
- **Style:** `BaseMap` uses `pmtiles://file://…/archive.pmtiles` with `file://` glyphs and sprites in three cases:
  - the user prefers the downloaded map (the default; it saves data);
  - there is no connection;
  - `/map/config` fails.
- **Offline behaviour:**
  - Map tab: the cached points in the viewport, with a notice. Panning re-filters them locally.
  - Preview: the straight-line distance is computed on the phone (haversine). "রাস্তায় কত দূর?" says plainly that it
    needs internet, and never waits for a timeout when the phone knows it is offline.
  - LocationPicker: the pin still confirms, and the area line comes from the cached outlines (point in polygon,
    most specific first). Address search says it needs internet.
- **Updates:**
  - Once per app run, when online and `updateCheckHours` has passed, the app looks for a newer version.
  - It downloads the new version itself only on Wi-Fi, and only if "ওয়াই-ফাইতে নিজে থেকে আপডেট" is on (the default).
  - Otherwise Profile shows a badge and the screen offers the update.
- **Delete:** removes the files, the row and the cached points.

### Not verified on a device yet

MapLibre Native reading `pmtiles://file://` and percent-encoded font-stack directories from `file://`. The style
code is unit-tested; a device check belongs to the week 9 QA pass.

## Part 2: demand/supply heatmap (admin, read-only)

### Decision 4: aggregated in SQL, never a point

`heatmap_cells(type, category, precision, window_days, min_people, limit)` is a SECURITY DEFINER function. Only
tenant admins and platform staff may call it; anyone else gets 42501.

- **Demand:**
  - searches with an origin (`search_queries`) in the last `heatmap_window_days`;
  - saved searches whose centre is inside the tenant's boundary. `saved_searches` is global per user (§13.29), so
    ownership comes from the boundary, not from a `tenant_id`.
- **Supply:** live posts, plus active stores (the store's location, else its place's). Stores count only without a
  category filter.
- Everything is grouped by `st_geohash(point, heatmap_geohash_precision)` and returns the cell centre, never an
  input point.
- A cell needs at least `heatmap_min_cell_count` **distinct people**. A person is the user, or the anonymous
  searcher hash for searches, or the post author or store owner for supply. So one person searching twelve times
  can't light a cell up. The function refuses a minimum below 2.
- At most `heatmap_cells_max` cells.

### Decision 5: the page

`/heatmap` in apps/admin is for analytics readers with the tenant_admin or partner_owner role. It shows demand and
supply side by side, on our own base map (maplibre-gl + pmtiles), with a category filter and synced cameras. It
draws geohash cells as squares, not a blurred kernel, so what you see is exactly what was aggregated.

## Settings added

| key                              | default                               | scope    |
| -------------------------------- | ------------------------------------- | -------- |
| `offline_map_max_mb`             | 50                                    | platform |
| `offline_map_max_zoom`           | 14                                    | platform |
| `offline_map_min_zoom`           | 11                                    | none     |
| `offline_map_buffer_km`          | 2                                     | platform |
| `offline_map_glyph_ranges`       | Latin, Bengali, punct.                | none     |
| `offline_map_point_sets`         | hospitals/pharmacies, info, landmarks | none     |
| `offline_map_update_check_hours` | 24                                    | none     |
| `offline_map_area_simplify_m`    | 25                                    | none     |
| `heatmap_min_cell_count`         | 5                                     | platform |
| `heatmap_window_days`            | 30                                    | none     |
| `heatmap_geohash_precision`      | 6                                     | none     |
| `heatmap_cells_max`              | 3000                                  | none     |

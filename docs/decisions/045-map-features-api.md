# ADR 045: The map data API — `GET /map/features` (GeoJSON, server-clustered, cached) and `GET /map/distance`

**Status:** Accepted (2026-10-06). Replaces Decision 6 of [ADR 044](044-geo-provider-and-map-screens.md)
(`map_clusters` / `GET /map/points`). Builds on [ADR 043](043-self-hosted-pmtiles-basemap.md) (the base map).
Amended the same day by migration 0040 (Decision 5): banks and ATMs in the info layer, a two-phase query, index use and a
text cache.

**Code:**

- API: `apps/api/src/map/map-features.{dto,repository,service}.ts`, `map/tiles.ts`, `map/map.controller.ts`
- Migrations: `0039_geo_provider_and_map_clusters` (the function `map_features()`), `0040_map_features_info_places`
- Tests: `src/map/*.spec.ts`, `test/map-features.db-spec.ts`, `test/map.e2e-spec.ts`, `test/geo.e2e-spec.ts`
- Benchmark: `apps/api/test/bench/map-features.bench.ts` (`pnpm --filter @amar-elaka/api bench:map`)
- Web: `apps/web/src/components/map/map-explorer.tsx`, proxy `/api/map/features`
- App: `apps/mobile/lib/features/map/`, models `packages/shared-types/dart/lib/src/map/map_features.dart`

## Context

The map screens need every public thing near the viewer on one map: posts, stores, places, landmarks and local info.
The map has to:

- answer fast for thousands of points;
- cost **zero** geo provider calls;
- stay radius-based (CLAUDE.md rule 10) — never filtered by tenant.

## Decision 1: one endpoint, GeoJSON, our database only

`GET /api/v1/map/features?bbox=minLng,minLat,maxLng,maxLat&zoom=&layers=&category=&open_now=`

- **The answer is a GeoJSON `FeatureCollection`** that map libraries take as a source as is. It also carries `zoom`,
  `layers`, `clustered`, `clipped`, `truncated` and `open_now_skipped`.
- **Properties are snake_case**, like the base map tiles' own, so a style reads both the same way.
  - A cluster: `{cluster: true, layer, count, expansion_zoom}`.
  - A point: `{cluster: false, layer, id, tenant_id, name_bn, name_en, category_slug, price, slug, info_kind, open_now}`.
  - `name_bn` and `name_en` are always present (null when unknown).
  - A post has one title. It goes to `name_bn` when written in Bengali script, to `name_en` otherwise.
- **The layers** (`layers=` a comma list; default: setting `map_layers_default`, all five):

  | Layer       | Source                                                                                                                           |
  | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
  | `posts`     | live posts (not sold, hidden or deleted)                                                                                         |
  | `stores`    | active stores                                                                                                                    |
  | `places`    | published / temporarily closed places that are not landmarks                                                                     |
  | `landmarks` | the same, landmarks                                                                                                              |
  | `info`      | active emergency services with a location; stops of active transport routes; places in `map_info_place_categories` (banks, ATMs) |

- **Filters.**
  - `category=` is a category slug, with its descendants. Stores, emergency services and bus stops have no category,
    so they drop out.
  - `open_now=true` keeps places and landmarks open now by `place_hours` (Asia/Dhaka), 24-hour emergency services
    and bus stops. Posts and stores have no hours, so they drop out, and `open_now_skipped` names them so the
    screen can say so.
- **Banks and ATMs** are places in the `bank-atm` category (categories.md §5.28), shown in `info` (Decision 5).
- **Never a provider call.** An e2e test asserts zero `GeoProvider` calls for features at zoom 8, 12 and 17 and for
  distance.

## Decision 2: clustering in PostGIS on a tile-aligned grid

`map_features()` is one `SECURITY DEFINER` function, as `discover_nearby` is. It is owned by `ae_rls_bypass` and
executable by `ae_app`.

- **What it returns.** Display columns that each table's public-read policy already shows to anyone, for public-state
  rows only. One query serves the whole map; nothing is hydrated from the search index or a second request.
- **The grid.** Below `map_cluster_until_zoom` (16), points are grouped per layer into Web Mercator cells of
  `map_cluster_cell_px` (64) pixels at the zoom. The cell size is rounded so a whole number of cells fills a 256 px
  tile, and cells never straddle tiles. A cell holding one feature returns that feature in full.
- **Why a grid, not DBSCAN or k-means.** A grid cluster depends only on the cell, never on the viewport. Panning never
  reshuffles clusters, and a tile's answer is the same for everyone, which is what makes it cacheable (Decision 3).
- **From `map_cluster_until_zoom`**, every feature is its own row.
- **Tap a cluster** and the client goes to `expansion_zoom` = min(zoom + 1, `map_cluster_until_zoom`).
- **The cap.** At most `map_features_max` (500) features. The service asks for one more to know when to set
  `truncated`. Order: the biggest clusters first, then the nearest to the centre.
- **Radius-based.** With a centre, only features within `map_viewport_max_radius_km` (25 km) of it are returned.
  Without one, the function refuses a box wider than that radius around its own centre. It never uses a tenant filter
  and never scans without a bound.

## Decision 3: the cache — per layer set, filters, zoom and tile-aligned box

In `MapFeaturesService`:

1. **Clamp.** The viewport is clamped to the square of side 2 × radius around its centre.
2. **Align.** It is rounded out to the whole tiles that cover it at the zoom.
3. **Key.** The Redis key is
   `map:features:v2:{layers sorted}:{category|-}:{open|any}:{clip|fit}:{z}/{x0}-{x1}/{y0}-{y1}:{tiles | centre}`, with
   a TTL of
   `map_features_cache_seconds` (60). The query uses the tile-aligned box, so a small pan inside the same tiles is
   served from the cache. Every user looking at the same tiles shares it.
4. **Zoomed out.** When the tile-aligned box reaches past the radius around its own centre, the radius is measured from
   the viewport centre, snapped to the clustering grid, and that centre joins the key. A pan smaller than a cell still
   hits the cache. The response is `clipped`.
5. **Text.** The value is the JSON text sent; a hit goes out as is, never parsed or re-serialized (`clipped` is in the
   key for that reason).
6. **Fail-open.** A Redis failure is logged and the database answers.

**Staleness.** A new post shows on the map within one TTL. That is acceptable for a map; the feed and search are live.

## Decision 4: distance — straight line now, the road only on a tap

`GET /api/v1/map/distance?from=lat,lng&to=lat,lng` returns:

- `straight_line_meters`, computed by PostGIS on the WGS84 spheroid, instantly and for free;
- a pointer, `route: {method: 'POST', path: '/api/v1/geo/route'}`.

Road distance and ETA come only from `POST /geo/route` on an explicit tap (ADR 044: a metered Barikoi call), never
while panning.

## Decision 5 (0040): banks and ATMs, a two-phase query, and the indexes

- **Banks and ATMs.** Setting `map_info_place_categories` (default `["bank-atm"]`) lists place categories, with their
  subcategories, that the map shows in `info` instead of `places`. Their `info_kind` is the category slug. The data comes
  from partners, agents and members adding places; it is never copied from a geo provider (ADR 044 storage rule).
  Importing OSM `amenity=bank|atm` would be a separate, ODbL-attributed task.
- **Two phases.** Phase 1 reads only id, tenant, point and `open_now` for every feature in the box, clusters and picks
  at most `map_features_max` + 1. Phase 2 reads names, prices, slugs and categories for the picked single features by
  primary key. The Bengali-script test on post titles and the category joins no longer run for 5,000 rows.
- **The indexes.** 0039 filtered with `location::geometry && envelope`; the GiST indexes are on `location`
  (geography), so that expression could not use them and every map request scanned the tables. 0040 filters with
  `location && envelope::geography` (index) and keeps the geometry test after it (exactly the box). With a small box
  the planner now picks `posts_live_category_location_gist_idx` / `places_location_gist_idx`.
- **Replacing the function** needs `SET LOCAL ROLE ae_rls_bypass` (its owner), as 0024 does.

## Settings (CLAUDE.md rule 9)

| Setting                      | Default  | Meaning                                   |
| ---------------------------- | -------- | ----------------------------------------- |
| `map_cluster_cell_px`        | 64       | cluster cell size in screen pixels        |
| `map_cluster_until_zoom`     | 16       | from this zoom every feature is a point   |
| `map_viewport_max_radius_km` | 25       | discovery radius from the viewport centre |
| `map_features_max`           | 500      | hard cap on features per response         |
| `map_features_cache_seconds` | 60       | Redis TTL per tile-aligned box            |
| `map_layers_default`         | all      | layers when the client does not say       |
| `map_info_place_categories`  | bank-atm | place categories shown in `info`          |

`map_cluster_max_zoom` and `map_points_max` (from the first ADR 044 draft) are gone. 0039 was edited in place, because
it has never been committed or deployed.

## Benchmark: 5,000 points in view, target p95 < 150 ms

`test/bench/map-features.bench.ts` sets up the data and the scenarios:

- **Data.** It seeds 3,000 live posts, 1,000 places, 500 stores and 500 emergency services into one Dhanmondi
  viewport.
- **Requests.** It calls the running API over HTTP, 300 requests per scenario.
- **Cold.** 25 distinct tile-aligned boxes, with the map cache flushed before each 25, so every request takes the
  database path.
- **Warm.** The same viewport each time, served from Redis.

It ran on the development laptop: WSL2, 8 cores, Postgres, Redis, the API and the benchmark on the same machine. This
laptop is about 3–4× slower than a server.

| Scenario                           | c=1 p50 | c=1 p95 | c=10 p50 | c=10 p95 |
| ---------------------------------- | ------- | ------- | -------- | -------- |
| cold, zoom 12 (16 clusters)        | 5 ms    | 42 ms   | 82 ms    | 135 ms   |
| warm, zoom 12 (cache)              | 5 ms    | 7 ms    | 13 ms    | 22 ms    |
| cold, zoom 16 (500 points, capped) | 45 ms   | 58 ms   | 167 ms   | 249 ms   |
| warm, zoom 16 (cache)              | 12 ms   | 18 ms   | 63 ms    | 80 ms    |

After 0040 and the text cache (same laptop, same data):

| Scenario                           | c=1 p50 | c=1 p95 | c=10 p50 | c=10 p95 |
| ---------------------------------- | ------- | ------- | -------- | -------- |
| cold, zoom 12 (16 clusters)        | 5 ms    | 34 ms   | 66 ms    | 132 ms   |
| warm, zoom 12 (cache)              | 4 ms    | 5 ms    | 14 ms    | 21 ms    |
| cold, zoom 16 (500 points, capped) | 42 ms   | 62 ms   | 163 ms   | 249 ms   |
| warm, zoom 16 (cache)              | 10 ms   | 19 ms   | 50 ms    | 106 ms   |

`map_features()` alone at zoom 16 went from about 30 ms to 22–26 ms (reading 5,000 rows: 20 → 7 ms). The HTTP numbers
barely moved: on this laptop the database, Redis, the API and the benchmark client share eight cores, so ten parallel
220 KB answers queue behind each other wherever the work is. The index fix does not show here (every seeded row is in
the box, so a scan is right); it matters on real tables, where 0039 scanned all of them for every request.

**Results.**

- **One request at a time:** every scenario is well under the target.
- **Ten at once:** the cached paths and cold clustering pass. Cold zoom 16 does not on this laptop, for two reasons:
  - ten simultaneous cache misses, each sorting 5,000 points;
  - one Node process serialising 220 KB answers.

  In production, misses are rarer, because tiles are shared across users for the TTL. On real hardware, with more API
  replicas, this case is expected to pass. **Re-run the benchmark on the VPS before launch.**

- **Note on cold z12 at c=1:** its p50 is low because several of the shifted boxes cover the same tiles at that zoom,
  so they share a cache entry. The p95 is the database path.

**Tuning that got here** (cold zoom 16, c=1, p95 82 → 58 ms):

- **No grouping from `map_cluster_until_zoom`.** Every point is its own row, so it is not grouped at all.
- **Cheap aggregates for one-point cells.** A one-feature cell takes its columns with `max()` (the max of one row is
  that row), not `array_agg` sorts.
- **Planar ordering.** Nearest-first uses squared distance on the plane, with longitude scaled by cos²(latitude),
  instead of 5,000 spheroid `st_distance` calls.
- **No redundant radius check.** Without a centre, the box already lies within the radius, so the per-row
  `st_dwithin` is skipped.
- **Mercator by formula.** Pixels come from the slippy-map formula instead of `st_transform`.

## Consequences

- **Clients replaced `/map/points` with `/map/features`.** Web, the app and the e2e stub moved. The map screens gained
  the five layer toggles, an open-now filter and an open/closed line on the card.
- **Places, landmarks and info have no page yet.** Their cards link nowhere for now; posts (web and app) and stores
  (web) open their pages.
- **Risk: cache staleness.** A moderated-away post can stay on the map for up to one TTL (60 s). It is gone from the
  feed, search and its page at once.

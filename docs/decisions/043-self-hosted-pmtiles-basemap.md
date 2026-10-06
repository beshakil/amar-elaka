# ADR 043 — The base map is our own Protomaps PMTiles file, rendered by MapLibre

**Status:** Accepted (2026-10-06). **Supersedes** [ADR 033](033-openstreetmap-maps.md) (raster tiles from
tile.openstreetmap.org). Barikoi's role (addresses, on the server) is unchanged from ADR 026.

**Code:** `scripts/map/build-tiles.sh`, `apps/api/src/map/`, `packages/map-style/`, migration
`0038_map_settings`, web `apps/web/src/components/map/`, app `apps/mobile/lib/core/map/`.

## Decision

These points were decided before this ADR and are not reopened here.

1. **Base map = Protomaps basemap tiles** (built from OpenStreetMap), as **one Bangladesh `.pmtiles`
   file**, served as a **static file from our VPS disk behind Cloudflare**. There is no tile server process.
2. **Rendering = MapLibre**: `maplibre_gl` in Flutter; `maplibre-gl` plus the `pmtiles` protocol in web and admin.
3. **Barikoi is not used for tiles.** The disabled emergency entry `map_style_fallback` could point at a
   Barikoi style URL. **Each Barikoi map load costs 4 Barikoi API calls**, so it is off (empty) and is
   only for emergencies.

## Why PMTiles

- **One file, read by HTTP range requests.** The client reads a small header and directory, then the
  byte range of each tile it draws. Any static file server or CDN can serve it. There is no tile server
  to run, patch, scale or monitor: the API serves the file with `@fastify/static`, which we already
  depend on.
- **Versioned file names make caching free.** Each build is a new file (`bd-YYYYMMDD.pmtiles`), cached
  `immutable` for a year. A refresh never needs a CDN purge: `GET /map/config` points clients at the
  new name, and the old file is kept for one cycle so maps already open keep working.
- **Vector tiles**: one dataset gives light and dark themes, Bengali or English labels, and sharp text
  at every zoom.

## Why not Barikoi tiles, and why not tile.openstreetmap.org

- **Barikoi**: every map load costs 4 billed API calls, which is a bill per screen view that grows
  with users. It would also put a key in the clients. Barikoi stays where it is strongest: addresses
  (autocomplete, reverse, Rupantor), called only from `apps/api`, cached and with a fallback.
- **tile.openstreetmap.org** (ADR 033): it is a volunteer service with no SLA, and its usage policy
  allows blocking heavy apps. Raster tiles also can't change the label language or theme.
- **Public Nominatim**: never used (policy: no autocomplete, at most 1 request per second).

## Size

These come from a real extract of the Protomaps daily build `20261005` (basemap schema 4.15.2), for the
bbox `87.95,20.55,92.75,26.75`. That is Bangladesh plus about 0.05° of margin, so border towns and the
sea off Cox's Bazar are covered.

| maxzoom | tiles   | file       | Cloudflare edge cache\* |
| ------- | ------- | ---------- | ----------------------- |
| 6       | —       | 1.2 MB     | (e2e fixture)           |
| 13      | 19,798  | 100 MB     | yes                     |
| **14**  | 75,722  | **199 MB** | **yes**                 |
| 15      | 282,049 | 557 MB     | **no**                  |

\*Cloudflare's non-Enterprise plans don't cache a file over 512 MB. At z15, every range request would
go to the VPS.

- **`map_tiles_max_zoom` = 14** (allowed range 10–15). MapLibre overzooms past z14, so street level
  still renders, from z14 geometry. 15 is Protomaps' deepest zoom.
- **The size costs disk and build time, not users.** A phone downloads only the ranges for the tiles
  it shows.
- `build-tiles.sh` prints the size and **warns above 450 MB**.
- The extract takes about 45 s on a home connection.

## Refresh cadence

**Monthly is enough.** Roads and neighbourhood names in Bangladesh don't change week to week, and our
own pins (posts, stores, places) carry the fresh data.

1. Run `scripts/map/build-tiles.sh` on the VPS. It reads the max zoom from `platform_settings`, takes
   the latest daily build, writes `bd-<date>.pmtiles` and `current.json`, and keeps one previous
   archive.
2. Run `scripts/map/build-tiles.sh --assets-only` only when the fonts or sprites are bumped. Their
   sources are pinned commits.

## Serving

| Path                                    | Cache-Control                         |
| --------------------------------------- | ------------------------------------- |
| `/tiles/bd-<version>.pmtiles`           | `public, max-age=31536000, immutable` |
| `/tiles/fonts/…`, `/tiles/sprites/v4/…` | `public, max-age=86400`               |
| `/tiles/current.json`                   | `no-cache`                            |

- `/tiles` is a static route outside `/api`. It needs no login and no tenant.
- Range requests get `206 Partial Content`, `Accept-Ranges: bytes` and an `ETag`. A bad range gets
  `416`. Dotfiles, directory listings and paths outside the directory are refused.
- **CORS**: the allowed origin is reflected for our web origins only (`MAP_TILES_CORS_ORIGINS`;
  default `https://<root>` and `https://*.<root>`, where `*` matches one label).
  `Content-Range`/`ETag` are exposed, and `Range` preflights are answered. Native apps send no Origin.
- **`GET /api/v1/map/config`** returns:
  - `tiles`: the archive URL, version, max zoom and bounds, or `null` before the first build. Clients
    then show a notice instead of failing.
  - `assetsBaseUrl`
  - `labelLanguage`: the `map_label_language` setting.
  - `fallbackStyleUrl`: the `map_style_fallback` setting, `null` when empty.

### Notes for week 13 (deploy behind Cloudflare)

1. **Cache rule for `/tiles/*`**: Cache Everything, and respect the origin's Cache-Control.
   - Cloudflare answers a range request on a cache miss by fetching the whole file once, under the
     size limit (hence z14).
   - Later ranges are cut from the edge copy, so the VPS sees about one full download per edge
     location per build.
   - Check this with `cf-cache-status: HIT` on a repeated `Range: bytes=0-16383`.
2. **No purges.** A new build is a new URL. `current.json` (`no-cache`) and `/map/config` are the only
   things that change. Stale archives are deleted by the script after one cycle.
3. **⚠ CORS behind a shared cache.** The origin reflects `Access-Control-Allow-Origin` per request,
   with `Vary: Origin`. Cloudflare's cache ignores `Vary` (except for images), so it would store the
   first origin's header and serve it to every other tenant subdomain. Fix it at the edge with one of:
   - a Response Header Transform Rule on `/tiles/*` that sets ACAO from the request's Origin for
     `*.amarelaka.com`;
   - or `Access-Control-Allow-Origin: *` for `/tiles/*`. The tiles are public, and nobody sends
     credentials.
   - Decide this when the hostname is final.
4. Upload size: the build runs on the VPS itself, so nothing goes over Cloudflare's upload limits.
5. **Web image**: `apps/web` copies MapLibre's worker into `public/maplibre/<version>/` before
   `next dev` / `next build` (`scripts/copy-maplibre-worker.mjs`). Webpack can't follow MapLibre's own
   worker URL. The standalone image must ship `public/`.

## Styles (`packages/map-style`)

`light.json` and `dark.json` are **generated** from the Protomaps basemap theme (`@protomaps/basemaps`)
by `pnpm --filter @amar-elaka/map-style generate`. They are never edited by hand. The Flutter app
bundles byte-identical copies in `apps/mobile/assets/map/`, and a test fails if they drift.

Changes from the Protomaps theme:

- **Fewer POIs**: only stations, ferry terminals, bus stops and airports, for orientation. Our own pins
  carry the POIs. House-number labels are removed.
- **Clearer roads**: darker casings.
- **Neighbourhood names readable at neighbourhood zoom (13–15)**: darker, larger, not uppercased, with
  a solid halo. Lane names start at z14.
- **Self-hosted glyphs and sprites** next to the tiles.
  - The font stacks are `Noto Sans Regular` and `Noto Sans Medium` (Italic is mapped to Regular).
  - Each stack has one font, because static glyph files can't merge stacks; that needs a glyph server.
  - Bengali text comes from **Noto Sans Bengali** font files through the style's `font-faces` (see the
    spike below).
- **The label language is a style parameter**, `resolveStyle(theme, {tilesUrl, assetsBaseUrl, lang})`
  (TypeScript), mirrored by `MapStyles.resolve` (Dart). Every name layer is tagged
  `metadata["amar-elaka:label"]`; road shields keep their `ref`. The two rules live in
  `styles/labels.json`, which both clients read:
  - **`bn`**: `name:bn`, else `name`. In Bangladesh, OSM's `name` is already Bengali (one Dhaka z12
    tile had 286 Bengali names and no `name:bn` key at all).
  - **`en`**: `name:en`, else `name` unless its first character is in U+0980–U+09FF, else no label. So
    Bengali is never map text in `en`.
    - Not `is-supported-script`: MapLibre GL JS 6 no longer wires it up, so it always returns true.
    - Also not Protomaps' own `en` rule, which falls back to Bengali `name` for most features here.

## Bengali shaping spike

**Rule (from the brief):**

- If conjuncts break, the default label language is **`en`**, and Bengali names are shown only in
  Flutter/HTML UI (sheets, cards), never as map text.
- The default is the setting **`map_label_language`**. It is seeded **`en`** and switched to `bn` only
  after a real Android phone and Chrome both pass.

**Debug screens:**

- **Web**: `/dev/map`. It returns 404 in production unless `ENABLE_DEV_PAGES=true`, which the e2e run
  sets.
- **App**: Profile → "মানচিত্রের বাংলা লেখা পরীক্ষা খুলুন" (debug builds only).
- Both draw ক্রিসেন্ট লেক, শ্যামলী, ধানমন্ডি ২৭, চট্টগ্রাম, ব্রাহ্মণবাড়িয়া and কক্সবাজার as map text,
  next to the same names as normal UI text. You can toggle theme and label language.

**Findings so far:**

1. **Glyph PBFs can't form conjuncts.** Protomaps' Noto Sans PBFs do hold the Bengali block (96
   codepoints in `2304-2559.pbf`), but one glyph per codepoint. There are no conjunct or reordered
   forms, and the basemap pre-shapes (`pgf:*`) only Hindi.
2. **MapLibre GL JS 6 shapes grapheme clusters.** It segments label text into grapheme clusters
   (`Intl.Segmenter`); a Bengali conjunct such as ক্র is one cluster. A multi-codepoint cluster is
   drawn by the browser's text engine, from the style's `font-faces` file when one covers it.
3. **With `font-faces` pointing at self-hosted Noto Sans Bengali** (Regular/Medium, about 145 KB each,
   OFL), headless Chromium draws all six names correctly. This machine has **no Bengali system font
   at all**: the HTML reference text on the same page shows as boxes. See:
   - [after](043/chromium-font-faces-dhaka.png) and [after, country view](043/chromium-font-faces-all.png):
     ক্র + ি, য-ফলা, ন্ড, ট্ট, গ্র, ব্র, হ্ম and ক্স are all correct, and so are basemap labels such as
     কুমিল্লা and টাঙ্গাইল;
   - [before](043/chromium-glyph-pbf-only.png): without `font-faces`, the clusters fall back to a
     system font that isn't there.
4. **Android**: `font-faces` is supported from MapLibre Android SDK 11.13 / iOS 6.18. `maplibre_gl`
   0.27.1 bundles **Android SDK 13.5.0**. **Not yet verified on a phone.** That check is the remaining
   gate before `map_label_language = bn`.

## Attribution (ODbL)

- **On every map**: "© OpenStreetMap contributors", linked to openstreetmap.org/copyright, and
  "Protomaps".
  - Web: MapLibre's attribution control, never collapsed. The credit comes from the style source.
  - App: always-visible text (`mapAttribution`), plus MapLibre's native (i) button.
- **ODbL scope**: we display a Produced Work from OSM data, which needs the credit above. We don't mix
  OSM into our own databases (posts, places, geo_areas, which come from BBS/COD-AB, ADR 003), so
  share-alike doesn't reach them.
- **Fonts**: Noto (OFL); `OFL.txt` is served next to them.
- **Barikoi**: a credit is shown wherever its search or address results appear.
  - Web: `map.barikoiAttribution`. App: `mapBarikoiAttribution`.
  - It shows only for `source: provider` results, never for our own area data.
  - **The wording is a placeholder** until confirmed against Barikoi's terms.
- **Admin boundaries**: the CC BY-IGO credit (ADR 003) is still required wherever boundaries are drawn.
  No map draws them yet.

## Consequences

- **The app uses MapLibre Native (`maplibre_gl`) instead of `flutter_map`.** That is a GL map, so more
  memory than raster tiles on 2 GB phones, which was ADR 033's reason against it.
  - **Profile the post location step with the ADR 038 procedure** before the week-8 map screens grow.
  - `baseMapEnabledProvider` turns the native view off in widget tests.
- Web: `leaflet` is removed. `maplibre-gl` and `pmtiles` are loaded lazily, so only map pages pay for
  them.
- The e2e suite carries a 2.3 MB fixture (`apps/e2e/fixtures/map`):
  - z0–6 tiles;
  - only the glyph ranges the test draws;
  - the sprites;
  - the two Bengali fonts.
- New env: `MAP_TILES_PATH`, `MAP_TILES_PUBLIC_URL`, `MAP_TILES_CORS_ORIGINS`.
- New settings: `map_tiles_max_zoom`, `map_label_language`, `map_style_fallback`.

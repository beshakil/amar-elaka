# ADR 033 — Maps are OpenStreetMap everywhere; addresses stay with Barikoi

**Status:** Superseded by [ADR 043](043-self-hosted-pmtiles-basemap.md) (2026-10-06): the base map is now our
own Protomaps PMTiles file; nothing loads tile.openstreetmap.org. Was: Accepted (2026-09-27). Code: `packages/shared-types/src/map.ts` (web, admin),
`apps/mobile/lib/core/map/map_config.dart` (app). Refines ADR 032 §6.

## Decisions

**1. One map for every client: OpenStreetMap's standard raster tiles.** Free, keyless and enough for our scale.

- The same values sit in `map.ts` and `map_config.dart`: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, max
  zoom 19, and the attribution.
- There is no per-build tile URL (the `MAP_TILE_URL` dart-define is gone) and no second provider.

**2. Why not Barikoi's map.** Barikoi publishes vector styles only (MapLibre GL `style.json`); every raster PNG path
returns 404. Using it would mean a native GL map (`maplibre_gl`): a new dependency, and more memory on 2 GB phones.

**3. Addresses stay with Barikoi, on the server.**

- Reverse, forward and autocomplete go through `BarikoiGeocodingProvider` (ADR 026). It is much better than OSM's
  Nominatim for Bangladeshi addresses (sections, roads, Bengali labels).
- OSM's public Nominatim forbids autocomplete and allows at most 1 request/second.
- The key is `BARIKOI_API_KEY`, only in `.env` locally and in Coolify's environment in production, never in the repo
  or the app. Without it, geocoding degrades to our own area data.

## Consequences

- OSM's tile usage policy applies, and every map must keep it:
  - the attribution is always visible;
  - requests identify the app (User-Agent `com.amarelaka.app`; the browser Referer on web);
  - no prefetching or bulk downloads;
  - HTTP caching stays on.
- OSM gives no SLA, and the policy lets it block heavy users. If traffic grows past what it tolerates, the fix is one
  constant in each of the two config files.
- Web and admin have no map screen yet; when they do, they read `@amar-elaka/shared-types`' `OSM_*` constants.

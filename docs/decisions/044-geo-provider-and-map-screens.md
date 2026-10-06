# ADR 044: The geo provider layer (Barikoi behind our API, metered), map clusters, map screens

**Status:** Accepted (2026-10-06). Builds on [ADR 026](026-location-system.md) (geocoding port, cache, fallback)
and [ADR 043](043-self-hosted-pmtiles-basemap.md) (the base map).

**Code:**

- Provider layer: `apps/api/src/locations/geocoding/`
- Map data: `apps/api/src/map/map-features.*` (ADR 045)
- Migration: `0039_geo_provider_and_map_clusters`
- CI check: `scripts/ci/check-geo-secrets.sh`
- Web: `apps/web/src/components/map/map-explorer.tsx`, `/map`
- App: `apps/mobile/lib/features/map/`, `lib/core/map/map_config_provider.dart`

## The rules (CLAUDE.md map rules)

- **Barikoi only from `apps/api`.** Autocomplete, reverse geocode, Rupantor and routing are called only from `apps/api`,
  through `GeoProvider`. The key never reaches a client, and CI enforces this.
- **Own data first.** Places, landmarks, stores and `geo_areas` are searched before Barikoi.
- **Every provider request is metered.** Each one is cached, counted in Barikoi **calls** against
  `barikoi_daily_call_budget`, and logged to `geo_provider_calls`. Over budget, a 429 or a timeout falls back gracefully.
- **Reverse geocode asks for the minimum fields.** Every extra field is an extra billed call.
- **Route and ETA only on an explicit user action.** Never while panning.

## What each user action costs

Numbers come from settings: `barikoi_cost_autocomplete` 1, `barikoi_cost_reverse_base` 1,
`barikoi_cost_reverse_per_field` 1, `barikoi_cost_rupantor` 2, `barikoi_cost_route` 2.

| User action                                                        | Endpoint                         | Barikoi calls               |
| ------------------------------------------------------------------ | -------------------------------- | --------------------------- |
| Open or pan the map, clusters, tiles                               | own PMTiles, `GET /map/features` | **0**                       |
| Straight-line distance (cards, feed, map, route fallback)          | PostGIS                          | **0**                       |
| Type a place, and our data has ≥ `geo_own_results_min` (3) matches | `GET /geo/autocomplete`          | **0**                       |
| Type a place, our data is thin, query not cached                   | `GET /geo/autocomplete`          | **1** per debounced query   |
| The same query again within the TTL (any user)                     | `GET /geo/autocomplete`          | **0** (cache)               |
| Area name for a point (`purpose=area`, the default)                | `GET /geo/reverse`               | **0** (`geo_areas`)         |
| Drop or move a post's pin (`post_location` → `[bangla]`)           | `GET /geo/reverse`               | **2**                       |
| Another pin in the same geohash-7 cell (about 150 m)               | `GET /geo/reverse`               | **0** (cache)               |
| Set up a store (`store_setup` → `[bangla, post_code]`)             | `GET /geo/reverse`               | **3**                       |
| Mark a place (`place_marking` → `[bangla]`)                        | `GET /geo/reverse`               | **2**                       |
| Tap "রাস্তা দেখুন"                                                 | `POST /geo/route`                | **2**                       |
| The same route again (rounded from/to)                             | `POST /geo/route`                | **0** (cache)               |
| Agent bulk address (Rupantor), not a client endpoint               | `GeoService.geocodeAddress`      | **2+** per address          |
| Budget spent, provider disabled, breaker open                      | NullProvider                     | **0**: our own data answers |

**Measured:** a reverse geocode with no optional fields already returns the English `address`, `area` and `city`.
`bangla` adds `address_bn`, `area_bn` and `city_bn`. So a post's Bengali address needs one extra field. The old code
asked for ten (district, thana, union…), costing 11 calls per tap. Our own `geo_areas` already have all of them.

**Example:** 300 new posts a day at about 1.5 uncached pins each, 100 thin searches and 50 routes come to about 1,100
calls a day.

## Decision 1: the interface and its implementations

```ts
interface GeoProvider {
  autocomplete(q, near?, opts: { bangla }): Promise<Suggestion[]>;
  reverseGeocode(lat, lng, fields: ReverseField[]): Promise<Address | null>;
  geocodeAddress(text): Promise<Candidate[]>; // Rupantor: bulk/agent use only
  route(from, to, mode): Promise<{ distanceMeters; durationSeconds; polyline? } | null>;
}
```

- **`BarikoiProvider`** is the real one. It sends exactly the fields it is asked for and nothing more. It has a timeout
  and one retry on a network error or 5xx. A 401/402/403 or 429 is never retried. The key never appears in a log or an
  error.
- **`NullProvider`** answers nothing. It is used when `geo_provider = null`, when there's no key, over budget (until
  midnight Asia/Dhaka), and while the breaker is open.
- **`FakeProvider`** is for tests only, with no network. It records every call so a test can assert "zero provider
  calls" or "only these fields".
- The `geo_provider` setting (`barikoi` | `null`) picks the provider. To add one, implement the port and list it in
  `GEO_PROVIDERS`.
- **TS naming:** the spec said `distance_m`/`duration_s`. In TS they are `distanceMeters`/`durationSeconds` (camelCase,
  per CLAUDE.md conventions).

## Decision 2: the only geo endpoints clients call

The old `/geocode/forward|reverse|autocomplete` and `GET /geo/route` are gone.

### `GET /geo/autocomplete?q=&lat=&lng=`

- It searches our own places (landmarks first), stores and `geo_areas`.
  - Places and stores come from the search index, which holds public documents only, across tenants and radius-based
    (`geo_own_radius_km`). The index matches Bengali, Banglish and English through its transliterations and synonyms.
  - Area names match in both scripts.
- Barikoi is asked only below `geo_own_results_min`. A query in the Bengali Unicode block asks for Barikoi's Bengali
  variant.
- Results are merged with our own first, each tagged `source: own | barikoi` and
  `kind: landmark | place | store | area | address`.
- **Limits:** a minimum query length (`geocode_autocomplete_min_chars`) and a per-client limit
  (`geo_autocomplete_per_client_per_minute`, keyed by user, else IP). Clients debounce as well.

### `GET /geo/reverse?lat=&lng=&purpose=`

- Areas always come from our `geo_areas` (PostGIS), for free.
- A street address comes from Barikoi only for `post_location`, `store_setup` or `place_marking`. Each purpose asks
  for the fields listed in its setting (`geo_reverse_fields_<purpose>`, a `text_array` validated against Barikoi's
  field list).
- **Cache key:** the point's geohash at `reverse_geocode_cache_precision` (7, about 153 m × 153 m), plus the field set.
  Nearby pins in one block share one paid answer.

### `POST /geo/route {from, to, mode?}`

- On an explicit tap only.
- Limited per client (`route_requests_per_client_per_hour`).
- Cached per rounded from/to (`route_point_decimals`).
- **Fallback:** the straight-line distance from PostGIS (`st_distance`) with `durationSeconds: null`. We never make up a
  travel time.

## Decision 3: cost control (every number is a setting)

- **Cache:** every provider answer is cached in Redis for `geo_cache_ttl_hours`. This is a conservative 24 h until
  Barikoi's terms on caching are confirmed. It's a setting, so raising it needs no deploy.
- **Budget:** `barikoi_daily_call_budget` per Asia/Dhaka day, in calls (base + per field for reverse). A Lua script
  reserves the cost **before** the call, so concurrent requests can't overshoot.
  - A call that never reached Barikoi gives its reservation back.
  - With Redis down, the day's spend is counted from `geo_provider_calls`.
  - If neither can count, no call is made.
- **Alerts:** at `barikoi_budget_warn_pct` (80%), platform admins get one in-app `geo_budget_warning` per day. At
  100% they get one `geo_budget_exhausted`, and NullProvider answers until midnight.
- **Circuit breaker:** a 429, timeout, network error or 5xx opens it for `geo_breaker_cooldown_seconds` (60). A
  401/402/403 doesn't open it, because that's a key problem, not a struggling provider.
- **No flow is ever blocked.** A post can always be created with just a pin and an area name.

## Decision 4: `geo_provider_calls` and `GET /analytics/geo-usage`

**One row per provider request:**

- Columns: `provider`, `endpoint`, `calls_counted`, `cache_hit`, `latency_ms`, `status`, `tenant_id`, `created_at`.
- `status` is one of `ok`, `empty`, `cache_hit`, `rate_limited`, `unauthorized`, `error`, `timeout`, `over_budget`,
  `disabled`.
- A cache hit always counts 0 calls (a CHECK constraint enforces it).

**Not tenant-scoped.** `tenant_id` is cost attribution only (`SET NULL`). RLS is forced:

- only the system role inserts and purges;
- platform and system read;
- members and tenant admins can neither read nor forge a row.

**No query text, no coordinates.**

**Retention:** logging cache hits makes the table grow with traffic. The nightly `purge-geo-provider-calls` job (`geo`
queue, JobRunner, visible in `/platform/jobs`) deletes rows older than `geo_provider_calls_retention_days` (90).

**`GET /analytics/geo-usage?days=`** is for platform staff (`@PlatformAdmin`; finance needs the cost too). It returns:

- calls, requests and cache hits per day;
- the cache hit rate: cache hits ÷ (cache hits + requests that reached the provider);
- the top endpoints by calls;
- today against the budget;
- this month so far, with a straight-line projection (calls so far ÷ days elapsed × days in the month).

The window is capped by `geo_usage_report_days_max`. This is an API endpoint only, not an admin dashboard (not in this
phase).

## Decision 5: storage and secrets

**Storage rule.** We store only the address text the **user** confirmed or edited, plus our own `geo_area_id`. We
never bulk-copy provider results into our tables.

- Today `posts` has no address-text column: the editor's address line is a preview.
- `places.address_text` has no write path from a provider.
- `architecture/geo-provider-boundary.spec.ts` keeps it that way: nothing outside the geo layer imports `GeoService` or
  a provider, so a provider answer can only flow back to the client that asked for it.

**Secrets.**

- `BARIKOI_API_KEY` lives only in `apps/api`'s environment.
- `scripts/ci/check-geo-secrets.sh` fails CI if the web or admin build (`.next`, `public`) or the app's `lib/` and
  `assets/` contain `barikoi.xyz`, anything shaped like a key (`bkoi_` + 20 characters), or the real key value
  (when the `BARIKOI_API_KEY` repository secret is set).
- Its self-test plants a key and expects failure.
- The architecture spec also checks that only the Barikoi provider (and the API's env defaults) names Barikoi's host.

## Decision 6: server-side clustering — superseded by ADR 045

The first `map_clusters` / `GET /map/points` design (counts and ids, hydrated from the search index) was replaced before
it was committed by **[ADR 045](045-map-features-api.md)**: `map_features()` and `GET /map/features`, GeoJSON from our
own tables with every display field, five layers, `open_now`, a tile-aligned Redis cache and `GET /map/distance`.

**Map screens** (web `/map`, the app's Map tab):

- Features are fetched when the camera rests, never while moving.
- Layer and open-now filters; a cluster tap zooms in; a point tap opens a card with details and route buttons.
- A list view of the same items is available.
- Attribution: OpenStreetMap and Protomaps on the map, plus the Barikoi placeholder credit under Barikoi answers.

## Migration notes

**0039 was rewritten in place** before it was ever committed or deployed (it existed only on the development
machine): the log's columns and the setting names changed to this design. 0039 also **deletes two seed rows** from
0021 that this layer replaced:

- `geocode_cache_days` → `geo_cache_ttl_hours`;
- `geocode_reverse_cache_decimals` → `reverse_geocode_cache_precision`.

No column is dropped. The settings parity test understands retired rows.

## To watch after launch

- **Barikoi billing:** compare its real billing per operation with the `barikoi_cost_*` settings (the dashboard against
  `geo-usage`).
- **Cache TTL:** raise `geo_cache_ttl_hours` once Barikoi confirms what its terms allow.
- **Own-data share:** how often our own data answers alone (autocomplete requests that log nothing at all).

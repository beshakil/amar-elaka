# ADR 026: Location system: real Bangladesh data, two tenant boundary modes, swappable geocoding

**Status:** Accepted
**Date:** 2026-09-25
**Builds on:** [ADR 003](003-geo-data-source.md) (data source), [§13.26](../specs/schema.md) (ownership vs discovery)
**Schema:** [§3.1 `geo_areas`](../specs/schema.md), `tenants` (§2.3), location helpers (§13.4b)
**Code:** `apps/api/src/locations/`, migration `0021_location_system`, `infra/geo/`

## Context

The platform needs:

- the hierarchy Country > Division > District > Thana/Upazila > Area/Ward, with real data, for cascading pickers and
  maps;
- tenant boundaries that work for upazilas, which have official polygons, **and** for urban metro thanas, which don't;
- PostGIS answers to four questions: is this point in this tenant; which tenant is nearest; how far apart are two
  points; what is inside this map viewport;
- address geocoding through Barikoi without depending on it: calls cost money, and the provider can be down.

## Decision 1: real data, committed as a pcode-keyed reference

**The source is HDX COD-AB v03** (BBS via OCHA, CC BY-IGO, valid from 2023-05-21), as ADR 003 decided. It contains:

| Level             | Count | Form    |
| ----------------- | ----- | ------- |
| Divisions         | 8     | polygon |
| Districts         | 64    | polygon |
| Upazilas          | 495   | polygon |
| City corporations | 12    | polygon |
| Unions            | 4,639 | point   |
| Pourashavas       | 259   | point   |

COD-AB has no Bengali names. We take them from **nuhil/bangladesh-geocode (MIT)**, which has no pcodes. So they are
matched to pcodes **once, offline**, by `build-reference.ts`, within the same parent: first the exact name, then a
spelling-insensitive key, then a unique near match. Division names, city-corporation names and the 11 upazilas the
dataset lacks are written out by hand. Every fuzzy match is listed for review in
`infra/geo/reference/name-bn-report.md`.

**Coverage:**

- Bengali names for 100% of divisions, districts, upazilas and city corporations;
- about 88% of unions and 73% of pourashavas.

The result is committed as `infra/geo/reference/bgd-admin-cod-ab-v03.json`: about 0.9 MB, one area per line. At
runtime, joins are **by pcode only**, as ADR 003 requires. Names never join anything.

**Polygons are not committed**: the full-precision ADM3 file alone is about 50 MB.

- `geo:import --boundaries <COD-AB GeoJSON dir>` loads them in production, in about 13 s. PostGIS parses the GeoJSON,
  so GDAL is not needed.
- For dev and tests, only the pilot district's polygons are committed (Mymensingh, 104 KB, simplified to about 50 m).

## Decision 2: two tenant boundary modes

A tenant's area is set by `tenants.boundary_mode`:

- **`polygon`**: the tenant covers the full-precision `geo_areas.boundary` of its area. This is right for any upazila.
- **`radius`**: the tenant covers `map_center` + `service_radius_km`. This is for places the open data has no polygon
  for: Dhaka's metro thanas (Mirpur, Gulshan…), new towns, or an early launch before boundaries are verified. The dev
  seed's Mirpur tenant uses it.

Platform admins switch modes with `PUT /platform/tenants/:id/boundary`. Polygon mode is refused when the area has no
polygon, and the radius is capped by `tenant_service_radius_max_km`. Both rules are enforced by CHECK constraints plus
the service.

## Decision 3: spatial questions are SQL helpers

The helpers are `tenant_covers_point`, `tenant_distance_m`, `nearest_tenants`, `geo_distance_m`, `geo_point`,
`geo_bbox` and `geo_areas_in_bbox`. The API, and future SQL (`resolve_owning_tenant`, `discover_nearby`), share one
definition of "inside" and "nearest". All of them are:

- SECURITY INVOKER, so they read through RLS;
- geography-based, so they give real metres on the WGS84 spheroid, never degrees;
- GiST-prefiltered with `ST_DWithin`.

**Nearest tenant ranks as follows.** A tenant that contains the point comes first. Then comes the smallest distance
**to the area**, not to its centre. Remaining ties go to the nearest centre. Suspended and archived tenants are
excluded.

`GET /tenants/nearby` now uses this function. That also fixes a bug: the tenant config's `radiusKm` used to be
computed on a 4326 _geometry_, which gives degrees, and was then divided by 1,000 as if it were metres.

## Decision 4: geocoding behind a port, cached, never failing

`GeocodingProvider` has three methods: `forward`, `reverse` and `autocomplete`. `BarikoiGeocodingProvider` implements
it:

- It uses Rupantor for forward geocoding, plus reverse geocode and autocomplete.
- Every call has a timeout and one retry on a network error or 5xx.
- 401, 402 and 429 are not retried.
- The API key never appears in logs or error messages.

To swap providers, bind `GEOCODING_PROVIDER` to another class.

`GeocodingService` adds:

- **A Redis cache for `geocode_cache_days` (30 days).** Keys are built from the provider name plus the normalised
  query. For reverse geocoding the point is rounded to `geocode_reverse_cache_decimals` (4, about 11 m), so nearby taps
  share one paid call. If Redis is down, the call is logged and continues without the cache.
- **A fallback that never fails the request.** If the provider is unavailable (including when no key is configured):
  - reverse geocoding still returns the coordinates, plus our own PostGIS areas at that point;
  - forward geocoding and autocomplete answer from our area names, in both scripts;
  - the response carries `degraded: true`.

  Degraded answers are never cached.

- **A 30-second circuit breaker**, so an outage doesn't cost every request a timeout.

## API

| Route                                                               | Purpose                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /locations?parentId=`                                          | Cascading picker. Without `parentId`, returns the divisions.            |
| `GET /locations/:id`                                                | An area with its ancestors, to prefill a picker.                        |
| `GET /locations/viewport?bbox=minLng,minLat,maxLng,maxLat&level=`   | Simplified GeoJSON for maps, plus the CC BY-IGO `attribution`.          |
| `GET /locations/lookup?lat&lng`                                     | Areas at a point, and whether the point is inside the request's tenant. |
| `GET /geocode/forward`, `/geocode/reverse`, `/geocode/autocomplete` | Geocoding, as described in Decision 4.                                  |
| `PUT /platform/tenants/:id/boundary`                                | Set a tenant's boundary mode. Platform admins only; audited.            |

## Consequences

- **After deploying:** run `geo:import --boundaries <dir>` once (see `infra/geo/README.md`), then move tenants' geo
  areas to the real rows. The old `seed-v1` dev rows are not in production.
- **Missing from the open data, to be filled by hand or a later dataset:**
  - city-corporation wards;
  - metro thanas (radius mode until then);
  - union polygons;
  - Bengali names for about 800 unions and pourashavas.
- **Attribution:** the text is in every viewport response. Map UIs must show it (ADR 003).

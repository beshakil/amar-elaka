# ADR 035 — The feed: radius discovery, ranking, boost cap and keyset paging

**Status:** Accepted (2026-09-27). Code: `apps/api/src/feed`, migration 0030 (`feed_posts`, `feed_stores`,
`feed_landmarks`, `posts.photo_count`, `posts.filled_field_count`, `categories.is_shippable`). Builds on ADR 025
(search, same radius rule) and 0023 (`discover_nearby`, the cross-tenant pattern). Tests:
`apps/api/test/feed.db-spec.ts`, `apps/api/test/feed.e2e-spec.ts`, `apps/api/src/feed/*.spec.ts`.

`GET /api/v1/feed?lat&lng&scope&radius_km&category&filters&cursor&limit` returns the home or category feed: ranked
post cards, mixed with nearby store cards and, on the first page, info cards.

## Decisions

**1. Ranking in SQL, cross-tenant ids only; cards read in the owning tenant.** Discovery is a radius (CLAUDE.md rule
10), but RLS keeps every plain `SELECT` inside one tenant (rule 1). As in `discover_nearby` (0023), three
`SECURITY DEFINER` functions owned by `ae_rls_bypass` return **ids, scores and distances only**: `feed_posts`,
`feed_stores` and `feed_landmarks`. The API then reads each card with a plain `SELECT` in the **owning tenant's context
as `anon`**, one read-only transaction per owner (`FeedService.inOwners`). It uses `anon` and never the viewer's role,
because a viewer who is a moderator at home is nobody in the neighbour's tenant. So a card never shows more than that
tenant's public-read policy allows, and no policy changed. A post hidden or sold between ranking and reading simply
drops out of the page. The functions clamp radius and page size by settings, like `discover_nearby`, so `ae_app`
can't turn them into an unbounded scan.

**2. Scopes.**

| `scope`          | Radius                                                                           | Categories                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `area` (default) | `feed_default_radius_km` (tenant-overridable, 5); `radius_km` ignored            | all, or `category` + descendants                                                                                               |
| `nearby`         | `radius_km` (default `feed_default_radius_km`), capped `feed_max_radius_km` (25) | same                                                                                                                           |
| `country`        | none                                                                             | `categories.is_shippable` only (fashion, gadgets-electronics); a non-shippable `category` is `400 FEED_CATEGORY_NOT_SHIPPABLE` |

Without `lat`/`lng`, the tenant's map centre stands in for the viewer (as in search). Stores and landmarks are
radius-based, so the country scope has none. `filters` is the same JSON as `/search`, parsed against the category
schema by `parseFieldFilters`. It is passed to SQL as data and evaluated by `post_field_filter_matches(fields, filter)`,
which mirrors `post-field-filters.ts`: generated columns cast directly, and everything else is guarded by its JSON type.

**3. The score.** Every term is scaled to 0–1 and weighted by a setting (platform scope, so staff can tune a tenant):

```
score = w_distance     · 0.5 ^ (distance_km / feed_distance_half_km)          proximity: halves every 2 km
      + w_recency      · 0.5 ^ (age_hours / feed_recency_half_life_hours)     freshness: halves every 48 h
      + w_boost        · (1 if boosted within the slot cap, else 0)
      + w_trust        · poster_trust / 100                                   override_score ?? score ?? trust_base_score
      + w_completeness · ( min(photos, feed_completeness_photo_target) / target
                         + filled fields / fields in the post's schema ) / 2
```

| Setting                          | Default | Why                                                                                                        |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `feed_weight_distance`           | 0.30    | local first: a listing 2 km away loses 0.15 against one next door                                          |
| `feed_weight_recency`            | 0.35    | freshest signal; `age = as_of − coalesce(bumped_at, published_at)`, so a bump or renewal resets it         |
| `feed_weight_trust`              | 0.15    | nudges reliable sellers up without letting old accounts own the feed                                       |
| `feed_weight_completeness`       | 0.20    | rewards photos (4 = full credit) and filled category fields                                                |
| `feed_weight_boost`              | 0.50    | a boost lifts a post above most organic ones, but a stale, far boost still loses to a fresh post next door |
| `feed_distance_half_km`          | 2       |                                                                                                            |
| `feed_recency_half_life_hours`   | 48      |                                                                                                            |
| `feed_completeness_photo_target` | 4       |                                                                                                            |

The four organic weights add up to 1.0, so an organic score is in [0, 1] and a boosted one in [0.5, 1.5]. Exponents are
capped at 1000 halvings, so a very far or old post decays to ≈0 instead of raising a float underflow. Ties break on
`id DESC`, so `(score, id)` is a strict total order. Completeness reads two denormalised columns: `posts.photo_count`
(trigger on `media_attachments`, `SECURITY DEFINER` so any writer keeps it right) and `posts.filled_field_count` (a
BEFORE trigger; see §9). Scoring 50k rows then needs no per-row join.

**4. The boost cap is enforced in the feed, not only at purchase.** Active boosts (`status_code = 'active'`,
`starts_at ≤ as_of < ends_at`, on a live post) are ranked per **owning tenant + category + placement**, earliest
`starts_at` first (then id). Only the first `boost_slots_per_category` count: the owning tenant's override, else the
platform default of 3 (schema.md §6.7, "slot capacity per placement + category"). A boost beyond the cap ranks
exactly as organic and has no badge. So an over-sold slot, a cut in the cap, or a purchase race can never put more
boosted posts in the feed than slots exist. The home feed counts `home_featured` boosts, and a category feed counts
`category_top`. `highlight` only adds a `highlighted` badge. `bump` already works through `bumped_at`. There is still
no purchase flow (Month 2 scope); this is the ranking hook.

**5. The mixed feed.** `limit` counts post cards. The other cards are placed around them (`feed-layout.ts`, pure and
unit-tested):

- **Stores:** one after every `feed_store_card_interval` (6) post cards, counted across pages so page 2 keeps page 1's
  rhythm. Nearest active store first, paged by its own keyset `(distance, id)` inside the cursor.
- **First page only**, at 1-based slots of the final list (0 turns a card off; all tenant-overridable): the emergency
  shortcut (`feed_emergency_card_position` 1, with `feed_emergency_card_items` national hotlines), bazar prices today
  (`feed_bazar_card_position` 4: the request tenant's published prices for today in Asia/Dhaka, min–max per commodity
  across markets, `feed_bazar_card_items`), and landmarks (`feed_landmark_card_position` 8, up to
  `feed_landmark_cards_max`).
- **Landmarks** come from any tenant, so a neighbour's district hospital shows across the boundary. A landmark
  qualifies when the viewer is within **its own reach**: `landmark_radius_km`, else the owning tenant's
  `landmark_default_radius_km`, else the platform default (schema.md §4.4). Ordinary places are not feed cards.

**6. Keyset cursor, stable while rows arrive.** The cursor (`feed-cursor.ts`, base64url JSON, zod-validated) carries
`as_of`, the origin, the resolved radius, the last `(score, id)`, the last store `(distance, id)` and the count of
post cards shown so far. It also carries a digest of scope, category, filters and radius; a cursor replayed with other
parameters is `400 FEED_CURSOR_INVALID`. Every page of one scroll scores with the **same clock (`as_of`) and origin**,
so a post's score can't drift between pages, and `(score, id) < cursor` never skips or repeats a row. There is no
OFFSET anywhere. Posts published or bumped after `as_of` are excluded (`coalesce(bumped_at, published_at) ≤ as_of`), so
new arrivals can't shift a scroll in progress. The next pull-to-refresh starts a new `as_of` and shows them. A cursor
can't move the clock forward (`least(p_as_of, now())`). The DB test inserts close, fresh posts in two tenants between
every page and asserts that the pages concatenate to exactly the one-shot ranking.

**7. First-page cache.** The first page is cached in Redis for `feed_cache_ttl_seconds` (60; 0 = off) under
`cache:<tenant>:feed:v1:<geohash>:<category|all>:<query digest>:<limit>`. The geohash is of the viewer at
`feed_cache_geohash_precision` (7, ≈150 m). The origin **snaps to the cell centre**, so the cached page is exactly what
every viewer in the cell would have got, and `distanceMeters` is accurate to about half a cell. Later pages are never
cached; they carry the cell-centre origin in the cursor. There is no explicit invalidation: a new post appears within
one TTL.

**8. Response: card fields only.** Post cards are `{kind, id, tenantId, title, price (string, 2 dp), cover {url,
thumbhash}, distanceMeters, area {bn, en}, badges, createdAt}`. `tenantId` says where the detail is read. `area` is the
post's locality, else its geo area. `badges` are codes the client translates (`boosted`, `highlighted`,
`verified_store`, `free`, `negotiable`); the API returns no user-facing text. Store, landmark, `bazar_prices` and
`emergency` cards are discriminated by `kind`. JSON is camelCase like the rest of the API (`distanceMeters`, as in
`/search`).

**9. Performance work, and why each piece is there.** Measured at **50 000 posts in one tenant** (45 000 live, 5 000
sold, 10 categories, 1 500 trust scores, 40 active boosts), spread over a 7 km disk. That puts 23 000 live posts
inside a 5 km radius: denser than a real upazila.

- **Estimate-proof plan.** PostGIS estimates the `st_dwithin` recheck at a handful of rows (5 estimated, 23 046
  actual), so any join after it became a nested loop. The first draft took 1.9 s, and 6 s once trust was joined. So
  the small sets are computed first into PL/pgSQL variables: capped boosted ids, highlighted ids, and schema field
  counts as `jsonb`. The per-post pass (`base`) then has no joins at all.
- **Exact trust pruning.** Trust is the only per-author lookup. It adds `w_trust · t/100` with `t ∈ [0, 100]`, so
  `base ≤ score ≤ base + w_trust` (IEEE multiplication and addition are monotonic). Let `B` be the `limit`-th best
  `base` among rows surely past the cursor (`base + w_trust < cursor`). At least `limit` rows then score ≥ `B`, so a
  row with `base + w_trust < B` can't make the page and never pays for its lookup. This is exact, not approximate: in
  the plan below, 348 of 22 988 rows are looked up. `scored` is `MATERIALIZED`, so the cursor test isn't pushed below
  the bound. When it was, all 22 980 rows paid on later pages (page 3 p95: 303 ms, now 187 ms).
- **`plan_cache_mode = force_custom_plan`** on the three functions. After five calls, PL/pgSQL's cached generic plan
  can't drop `radius IS NULL OR st_dwithin(…)` and loses the GiST index (page 3 p95: 587 ms with it, 303 ms with
  custom plans).
- **Sphere distances** (`use_spheroid = false`) for the radius test, proximity and `distance_m`. They are within 0.3%
  of WGS84 across Bangladesh and cut the per-row cost by about a third. The DB test defines "within the radius" the same
  way.
- **Indexes.** `posts_location_gist_idx` (0005, live posts) serves the all-categories feed. The new
  `posts_live_category_location_gist_idx` on `(category_id, location)` for live posts serves category feeds within a
  radius and the country scope (the category plan uses it: 43 ms). Boosts use `boosts_active_ends_idx` (0007) and
  trust uses `member_trust_scores_member_uq` (0027).
- **`filled_field_count` is not a generated column.** BEFORE triggers see stored generated columns as NULL in `NEW`,
  which made `posts_zz_search_carry_synced` (0020) treat every post update as a real edit. `search-sync.db-spec`
  caught it. A `posts_a_…` BEFORE trigger sets it instead. The 0030 backfill disables the updated_at and search-sync
  triggers while it runs; neither column is in a search document.

`EXPLAIN (ANALYZE, BUFFERS)` of the main query inside `feed_posts` (via `auto_explain`, nested statements). Area
scope, 5 km, home feed, first page of 20:

```
Limit (actual time=168.362..169.626 rows=20 loops=1)
  Buffers: shared hit=4486
  CTE base
    ->  Gather (actual time=17.147..115.758 rows=22988 loops=1)
          Workers Planned: 2  Workers Launched: 2
          ->  Parallel Bitmap Heap Scan on posts p (actual time=10.180..100.877 rows=7663 loops=3)
                Recheck Cond: ((status_code = 'live') AND (deleted_at IS NULL) AND (NOT hidden_by_owner))
                Filter: ((COALESCE(bumped_at, published_at) <= as_of) AND ((expires_at IS NULL) OR (expires_at > as_of))
                         AND st_dwithin(location, origin, 5000, false))
                Rows Removed by Filter: 3114
                ->  Bitmap Index Scan on posts_location_gist_idx (actual time=14.595..14.596 rows=32331 loops=1)
                      Index Cond: (location && _st_expand(origin, 5000))
  CTE eligible
    ->  CTE Scan on base b (actual time=17.152..129.183 rows=22988 loops=1)
  CTE bound
    ->  Aggregate (actual time=129.079..129.081 rows=1 loops=1)
          ->  Limit -> Sort (top-N heapsort) -> CTE Scan on eligible e (rows=22988 loops=1)
  CTE scored
    ->  Nested Loop (actual time=146.320..167.541 rows=348 loops=1)
          Join Filter: ((bound.n < 20) OR ((e_1.base_score + 0.15) >= bound.b))
          Rows Removed by Join Filter: 22640
          SubPlan 4
            ->  Index Scan using member_trust_scores_member_uq on member_trust_scores m (actual time=0.005..0.005 rows=1 loops=348)
  ->  Sort (actual time=168.359..168.362 rows=20 loops=1)
        Sort Key: s.score DESC, s.id DESC   Sort Method: top-N heapsort  Memory: 28kB
        ->  CTE Scan on scored s (rows=348 loops=1)
Execution Time: 169.6 ms (with per-node timing on)
```

The boosts, highlights and schema-size statements run before it in 0.7, 0.1 and 0.1 ms.

`feed_posts` latency, 200 calls per row from random viewers within 3 km of the centre, no instrumentation:

| Case                                    | Candidates | p50 ms | p95 ms | p99 ms |
| --------------------------------------- | ---------- | ------ | ------ | ------ |
| area 5 km, home, page 1                 | ~23 000    | 162    | 191    | 203    |
| area 5 km, home, page 3 (cursor)        | ~23 000    | 168    | 187    | 192    |
| area 5 km, one category                 | ~2 300     | 63     | 73     | 82     |
| country, shippable (2 of 10 categories) | ~9 000     | 92     | 111    | 147    |
| nearby 25 km, home (every live post)    | 45 000     | 270    | 301    | 337    |

The whole endpoint (settings, ranking, hydration per owner, stores, info cards, JSON), over HTTP with the cache off:
area p95 247 ms, nearby 25 km p95 341 ms. A cached first page is served in about 3 ms.

**The machine matters.** These numbers come from a Ryzen 5 7520U laptop under WSL2, where
`SELECT count(*) FROM generate_series(1, 1e6)` takes 348 ms (a typical server core takes about 80–100 ms). The
p95 < 200 ms target is **met here for the ranking function at 5 km, on every page, for categories and for the country
scope**. It is **not met here for a 25 km radius over all 45k posts, or for the uncached endpoint**. At the 3–4×
difference suggested by that calibration, all of them should land well under 200 ms on the Contabo VPS. That is an
estimate, not a measurement: re-run `feed_posts` under `auto_explain` on the VPS once real data exists.

## Consequences

- Rule 10 holds end to end: nothing filters by `tenant_id`. The DB test shows a post across the boundary inside the
  radius, a post just outside excluded, and a neighbour's landmark included by its own reach.
- The ranking is policy in settings. A weight or half-life change needs no deploy, and a per-tenant override needs
  platform staff (scope `platform`). The layout positions and default radius are the tenant admin's (scope
  `tenant_admin`).
- A post bumped mid-scroll leaves that scroll (its `bumped_at` is past `as_of`) and returns on refresh.
- Stores rank by distance only. There is no store score until reviews and subscriptions exist (months 3–5).
- The country scope scans every live shippable post in the country, bounded only by expiry (`post_expiry_days`). At
  national volume it should move to Meilisearch (ADR 025) or a precomputed ranking. The first things to try if the VPS
  misses the target at 25 km: denormalise poster trust onto posts (drops the lookup), or add a planar
  (`EPSG:3106`) point column for cheaper distance.
- `packages/shared-types/openapi.json` gains `/feed`. `filtersParam` is now exported from the search DTO and shared
  with the feed.

# ADR 040 — The search API: scopes, facets, sorting, suggestions, trending and the query log

**Status:** Accepted (2026-09-28). Code: `apps/api/src/search/` (`query/`, `search.controller.ts`,
`cli/zero-results.ts`); migration `0034_search_api.sql`. Builds on ADR 025 (the index, three-script matching, the
outbox) and ADR 035 (feed scopes, the boost slot cap).

Month 1 built the index and a basic `GET /search`. This ADR finishes the API the apps and the web build on:

- the feed's scopes;
- facets for the filter UI;
- a real sort;
- cursor paging;
- as-you-type suggestions;
- trending queries;
- a query log that feeds synonym tuning and unmet-demand analytics.

## Endpoints

| Endpoint                      | What it returns                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/v1/search`          | `q, type, scope, lat, lng, radius_km, category, filters, price_min, price_max, sort, cursor, limit` |
| `GET /api/v1/search/suggest`  | `{ categories, queries, listings }` for the typed text                                              |
| `GET /api/v1/search/trending` | the tenant's top queries over `trending_window_hours`                                               |
| `POST /api/v1/search/click`   | `{ searchId, postId }`: the searcher opened a result                                                |

All four are public. A signed-in searcher is recognised (optional JWT) so their log row carries `user_id`.

## Decisions

**1. Scopes are the feed's.** `scope = area | nearby | country`, exactly as `GET /feed` (ADR 035):

| Scope     | Radius                                                              | What it covers            |
| --------- | ------------------------------------------------------------------- | ------------------------- |
| `area`    | `search_default_radius_km` (tenant setting); `radius_km` is ignored | everything nearby         |
| `nearby`  | `radius_km`, capped at `search_max_radius_km`                       | everything nearby         |
| `country` | none                                                                | shippable categories only |

- **Always a radius** (§13.26): without `lat`/`lng`, the tenant's map centre stands in, and hits then carry no distance.
- **The country scope** needs a new document field, `is_shippable` (the post's category). A category that never ships
  answers 400 `SEARCH_CATEGORY_NOT_SHIPPABLE`, as in the feed.
- **Landmarks are included** the way the feed includes them: the first page of a text search with no category also
  returns `landmarks[]`, the matching landmark places within the radius (up to `search_landmarks_max`). They come in
  their own list, so post paging, counts and facets stay clean.

**2. Sort.** `relevance` (default) | `newest` | `price_asc` | `price_desc` | `distance`, plus `rating` for stores and
places. `nearest` is still accepted and means `distance`.

- **The problem:** in Meilisearch the `sort` rule comes after the text rules (ADR 025, decision 3). So "flat, cheapest
  first" would really be "best match first, cheapest among equals", and the prices would jump around.
- **The fix:** an explicit sort of a text search runs in two steps:
  1. collect the ids that match every word (`matchingStrategy: all`, up to `search_max_total_hits`);
  2. run a placeholder search over just those ids (`id IN […]`), where the text rules tie and the sort really sorts.
- **Boosts still come first** (below), exactly as on a category page.
- **Relevance and browsing** (no text) stay one query, as before.
- **Where it lives** (since ADR 041): step 1 is `SearchMatcher.matchingIds`, the same code saved-search alerts use.

**3. Boosts obey the feed's slot cap.**

- **The bug it fixes:** the index used to mark a post boosted if it had any active boost, so search ignored
  `boost_slots_per_category`.
- **The rule now:** `is_boosted` is decided exactly as in `feed_posts` (0030):
  - only `category_top` boosts count (the placement the feed uses for a category page);
  - only the first `boost_slots_per_category` in the post's tenant and category, by start, count (the tenant's
    override, else the platform's);
  - further boosts rank as organic.
- **Keeping it fresh:** whether one post counts depends on the others, so:
  - a boost change emits `search.resync` scope `boost_post`, which re-syncs its category's boosted posts;
  - a change of the cap emits scope `boosted`;
  - the relay's 2-second run re-syncs posts whose boost window opened or closed (no row changes then, so no trigger
    fires).

**4. Facets.** For the filter UI, computed on the same filters as the hits:

- `categories`: counts per category slug.
- `price`: 1-2-5 × 10ⁿ taka ranges adapted to the results' min and max, at most `search_price_bucket_count` of them,
  so rents get thousands and vegetables get tens. Each range is counted exactly (a count-only multi-search).
  - The ranges ignore the price filter itself, so choosing one still shows the others.
  - A range's `min`/`max` go back as `price_min` (inclusive) / `price_max` (exclusive).
- `fields`: the chosen category's first `search_facet_fields_max` select-type fields (select, multiselect, bool, in the
  schema's filterable order) as value counts, plus its numeric and date fields as ranges.

**5. Paging is a cursor.**

- **Why an offset:** Meilisearch pages by offset, so the cursor is the next offset.
- **Bound to the search:** the cursor also carries a digest of everything that decides the list: query, type, scope,
  origin, radius, category, filters, price, sort and page size.
- **A cursor from another search** answers 400 `SEARCH_CURSOR_INVALID`.
- **`page=` still works** for the web's category pages; `nextCursor` is null on the last page.

**6. Suggestions.** `GET /search/suggest?q=` returns:

- matching categories (up to `search_suggest_categories_max`);
- popular queries of this tenant (up to `search_suggest_queries_max`);
- the top listing titles nearby (up to `search_suggest_listings_max`, 5).

It works in Bengali, Banglish and English:

- the input is matched as typed, as its Banglish, and through its dictionary synonyms;
- each category and popular query is matched with its Banglish, computed once when the list is cached.

Meilisearch prefix-matches only a query's last word, so half-typed Bengali goes to the engine twice: as itself and
as its Banglish ("ডাক" finds ডাক্তার, "dak" finds "daktar"). The results are merged.

**7. The < 50 ms budget.** A keystroke costs:

| Part                           | Where it comes from                                         | Measured                             |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------ |
| settings                       | in-process cache                                            | —                                    |
| categories and popular queries | Redis (`search_list_cache_seconds`)                         | —                                    |
| the service's own matching     | 500-entry popular pool                                      | < 5 ms per call (unit test)          |
| the engine                     | one Meilisearch multi-search, run alongside the Redis reads | 3–5 ms processing (real-engine test) |

- **Whole request**, from a plain Node process on this laptop (3–4× slower than the server): about 10 ms.
- **Why the real-engine test times only the engine:** inside Jest, a local HTTP POST alone costs about 45 ms, so the
  test checks Meilisearch's reported processing time instead of the wall clock.

**8. The query log** (`search_queries`, schema.md §8.12).

- **What is logged:** the first page of every text search, not degraded ones (their counts cover one tenant only).
- **What a row holds:**
  - the normalized query only, never the raw text, for anyone;
  - a digest of the filters, not the location;
  - the result count;
  - `user_id` for a signed-in searcher;
  - a `searcher_hash`: an HMAC of the user, install id or IP + agent, and the UTC day. It counts distinct searchers
    without an identity, and changes daily.
- **Clicks:** the response carries `searchId`, and `POST /search/click` records the opened post once, through
  `record_search_click`. The searcher may not read or update the log.
- **Scrubs:** a scrubbed post's clicks are cleared by trigger.
- **A logging failure never fails the search.**

**9. Trending needs distinct searchers.** `GET /search/trending` returns this tenant's queries that found something
over `trending_window_hours`, ranked by distinct searchers, and only those with at least
`search_trending_min_searchers` (3). So one person searching fifty times can't make a query trend. It comes from
`search_popular_queries`, a SECURITY DEFINER function that returns aggregates only, and is cached per tenant. The
suggestion pool is the same function over `search_popular_window_days`.

**10. Freshness, sold and scrubbed.** Nothing new here beyond fixing one gap:

- **Unchanged:** the outbox relay (ADR 025) still carries every create, edit, sale and removal to the index within
  about 2 seconds.
- **Sold** is not `live`, so the loader removes the post.
- **The gap:** the loader's "indexable" test ignored `scrubbed_at`, and a privacy scrub keeps the status. A
  scrubbed post now leaves the index whatever its status, and the Postgres fallback leaves it out too.

**11. Synonym workflow.** `pnpm --filter @amar-elaka/api search:zero-results [--days N] [--limit N]` prints the queries
that found nothing in the last `search_zero_result_report_days` (7), as a Markdown table:

- the query and its Banglish;
- its searchers, searches and tenants;
- the words the dictionary already knows.

The steps are in [search-synonyms.md](../specs/search-synonyms.md).

## Settings (0034)

| Setting                                                                                        | Default   |
| ---------------------------------------------------------------------------------------------- | --------- |
| `trending_window_hours` (tenant)                                                               | 24        |
| `search_trending_min_searchers` (tenant)                                                       | 3         |
| `search_trending_limit`                                                                        | 10        |
| `search_list_cache_seconds`                                                                    | 300       |
| `search_popular_window_days`                                                                   | 30        |
| `search_popular_pool_size`                                                                     | 500       |
| `search_suggest_listings_max` / `search_suggest_queries_max` / `search_suggest_categories_max` | 5 / 3 / 3 |
| `search_facet_fields_max`                                                                      | 4         |
| `search_price_bucket_count`                                                                    | 5         |
| `search_landmarks_max`                                                                         | 3         |
| `search_click_window_minutes`                                                                  | 60        |
| `search_zero_result_report_days` / `search_zero_result_report_limit`                           | 7 / 50    |

`search_suggest_limit` (0020) is no longer read; the per-group maximums replaced it.

## Consequences

- **Reindex once after deploying:** `search:reindex` adds `is_shippable` and the capped `is_boosted` to every document,
  and makes `id` filterable.
- **Breaking change for suggest:** its response changed shape (`categories`, `queries`, `listings` instead of one
  mixed list). No client used it yet.
- **Tokens:** an invalid bearer token on `/search` now answers 401 (the optional guard), where it used to be ignored.
  A missing token is fine.
- **Tests:**
  - `search.e2e-spec.ts` runs the whole path: Postgres → outbox → relay → Meilisearch → HTTP;
  - it checks that ডাক্তার / daktar / doctor / dakter return the same listings, that a sold post leaves and a
    scrubbed one disappears everywhere, and the log, click and trending rules;
  - `search-api.db-spec.ts` proves cross-tenant isolation of the log.
- **Known limits:**
  - An explicit sort covers at most `search_max_total_hits` matches, the same depth relevance can page to.
  - The `searcher_hash` counts an anonymous person once per day, so over a window longer than 24 hours someone
    searching daily counts once per day.
  - `search_queries` has no retention purge yet. Before launch it needs one (with a legal-hold check, CLAUDE.md
    rule 11), or a partition drop like `lead_events`.

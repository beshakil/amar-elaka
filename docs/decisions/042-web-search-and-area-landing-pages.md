# ADR 042 — Search on the web, and category + area landing pages

**Status:** Accepted (2026-09-28). Code: `apps/web/src/app/search/`, `apps/web/src/components/search/`,
`apps/web/src/lib/search/`, `apps/web/src/app/category/[slug]/[area]/`, `apps/web/src/app/api/search/suggest/`,
`apps/web/src/app/api/saved-searches/`; API `apps/api/src/seo/` (`GET /seo/category-areas`) and the `area` parameter of
`GET /search`; migration `0036_area_landing_pages.sql`. Builds on ADR 039 (public listing pages and SEO), ADR 040 (the
search API) and ADR 041 (saved searches).

The web gets the same search as the app. Search result pages are for people and are kept out of the index. The long-tail
Bengali queries we want to rank for ("মিরপুর ১০-এ বাসা ভাড়া") get their own indexable pages: one per category and area,
and only where the area has enough listings.

## Pages

| URL                        | What it is                                                                                     | Robots              |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| `/search?q=…&category=…&…` | results, facets, sort, empty state, save                                                       | `noindex, follow`   |
| `/category/<slug>/<area>`  | a category's listings in one area (newest first), breadcrumbs, ItemList JSON-LD, sibling areas | `index, follow`     |
| `/category/<slug>`         | unchanged, plus a "by area" list of its landing pages (page 1 only)                            | as before (ADR 039) |

## Decisions

**1. The search state is the URL.**

- Every filter, the sort and the page are query parameters in a fixed order: `q`, `category`, `area`, `f.<field>.<op>`,
  `price_min`, `price_max`, `sort`, `page`. The order is fixed so one search has one URL.
- Facets, sort options and filter chips are links, not controls. Each is a URL, so the back button, sharing and
  JavaScript-free use all work the same way.
- `parseSearchParams` never throws. It drops what it can't read: an unknown sort, a malformed slug, a reversed price
  range, an over-long `q`. A hand-edited URL shows a search, never an error page.
- Changing anything except the page resets the page to 1. Changing the category drops the field filters, which belong to
  the old category's schema.

**2. Result pages are noindex; their links are nofollow.**

- The combinations are endless, and most are thin or duplicates of each other.
- `noindex, follow` lets crawlers reach the listings through the results without indexing the results page itself.
- Facet, sort and pagination links carry `rel="nofollow"`, so crawl budget isn't spent on filter permutations.

**3. Header suggestions.**

- The header's box is an ARIA combobox over a same-origin BFF, `GET /api/search/suggest`, which proxies
  `GET /search/suggest` uncached.
- It waits 250 ms after typing stops and needs at least 2 characters. Only the answer to the latest text is shown; older
  requests are aborted.
- Keys: ↑/↓ move, Enter opens the highlighted suggestion or else submits the text, Esc closes.
- Keys pressed while an IME is composing are ignored, and the text is never rewritten, so Bengali input methods keep
  working.
- Without JavaScript, the box is a plain GET form to `/search`.
- The submit button is labelled "সার্চ করুন", so it can't be confused with other "খুঁজুন" buttons, such as the address
  search on the post form.

**4. Web searches are anonymous but identified.**

- The page calls `GET /search` server-side without the user's token.
- It forwards the visitor's install id (the `ae_install` cookie), IP and user agent. With these, the query log and
  trending (ADR 040) count distinct searchers, not "the web server".
- Results are never cached: they depend on the text and the ranking signals.

**5. Area landing pages, and when they exist.**

- `localities.slug` is new: lowercase and hyphenated from `name_en` (so "Mirpur 10" becomes `mirpur-10`), unique per
  tenant. An area without an English name gets `area-<8 hex of its id>`.
- The slug is set on insert and **never rewritten on rename**, so a URL that ranks never moves. A rename that should move
  it is a manual slug change plus a redirect, which is out of scope for now.
- `GET /search?area=<slug>` resolves the area. The search is centred on the area's centre (or the tenant's, if the area
  has none) and filtered to `locality_id = <area>`. An unknown slug returns `404 SEARCH_AREA_NOT_FOUND`.
- `GET /seo/category-areas` lists the `(category, area, count)` pairs with at least `seo_area_page_min_listings`
  listings.
  - The setting defaults to 5 and a tenant admin can override it.
  - Counts come from one multi-search facet query per area, through the **same `SearchCriteria` and `SearchMatcher`** as
    the landing page's own search.
  - A category's count includes its active descendants.
- The page, its 404 gate in the middleware, the category page's "by area" links and the sitemap (`pages.xml`) all read
  that one list. They can't disagree: an area below the threshold has no page, no link and no sitemap entry. It returns
  404, not a thin page.
- Degraded behaviour:
  - If search is unavailable, `/seo/category-areas` returns `503 SEARCH_UNAVAILABLE`.
  - The gate then lets the request through; the page itself renders or fails normally.
  - The sitemap and the "by area" links leave the pairs out rather than failing.
- Discovery stays radius-based (hard rule 10). The area narrows by `locality_id` inside the tenant's own radius, and the
  tenant decides which areas exist, not which listings are visible.

**6. Saving a search from the web.**

- A signed-in user saves the search on screen with a plain POST form to `/api/saved-searches`. The route checks
  `Origin`, builds the body with `savedSearchBody` and calls `POST /saved-searches` (ADR 041).
- The body uses the same filter parser as the page, the tenant's centre and the radius on screen.
- The route then redirects back (303) to the same search, with `saved=1`, `saveError=limit&max=N` or
  `saveError=failed`. That is post → redirect → get: a refresh never saves twice.
- The return path is accepted only if it is `/search?…` (`safeSearchReturn`). An expired session goes to
  `/login?next=<the search>`.
- A guest sees "log in to save this search", linking to `/login?next=<the search>`.

## Settings

| Key                          | Default | Override     | Meaning                                                             |
| ---------------------------- | ------- | ------------ | ------------------------------------------------------------------- |
| `seo_area_page_min_listings` | 5       | tenant_admin | Listings an area needs in a category before its landing page exists |

The landing pages' cache lifetime reuses the tenant's `categoryRevalidateSeconds` (ADR 039).

## Tests

| Where                                     | What it covers                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/seo/category-areas.spec.ts` | category-tree roll-up, threshold, sort, per-area criteria, 503                                                                                                                             |
| `apps/api/test/area-slugs.db-spec.ts`     | the slug rule, `-2` within a tenant, the id fallback, kept on rename, malformed or duplicate refused                                                                                       |
| `apps/api/test/search.e2e-spec.ts`        | `/seo/category-areas` against Meilisearch, `/search?area=`, unknown area 404                                                                                                               |
| `apps/web` vitest                         | URL parsing and building, save body and return path, the area gate                                                                                                                         |
| `apps/e2e/tests/web-search.spec.ts`       | suggestions with the keyboard; URL state, facets, back button, shared URL, noindex and nofollow; empty state; guest and seller save, and the limit; landing page, canonical, sitemap, 404s |

## Consequences

- A new area gets its landing pages automatically once it has enough listings. Areas with too few listings stay out of
  the index.
- Changing an area's English name doesn't change its URL. Renaming the slug is a manual step for now.
- Next's fetch cache (`.next/cache/fetch-cache`) survives `next build`. After a change to an API response's shape,
  delete it locally before running the e2e suite, or old-shaped cached responses fail the zod checks.

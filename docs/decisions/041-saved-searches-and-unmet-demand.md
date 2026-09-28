# ADR 041 — Saved searches, alerts and unmet demand

**Status:** Accepted (2026-09-28). Code: `apps/api/src/saved-searches/`, `apps/api/src/search/query/search-matcher.ts`,
`search-criteria.service.ts`, `apps/api/src/analytics/unmet-demand.*`; migration
`0035_saved_searches_and_unmet_demand.sql`. Builds on Q25 / §13.29 (saved searches are global to the user), ADR 031
(scheduled jobs), ADR 040 (the search API and its query log).

A buyer who finds nothing today can save the search and be told when something appears. The same saved searches, with
the searches that found (almost) nothing, show tenant admins what their area is missing.

## API

| Endpoint                               | What it does                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /saved-searches`                 | `{ name, q, filters: { category, fields, price_min, price_max }, center, radius_km, frequency }` |
| `GET /saved-searches`                  | the user's searches, each with `newResultCount`, plus the total (the badge) and `maxActive`      |
| `GET/PATCH/DELETE /saved-searches/:id` | standard; `PATCH { active: true }` resumes a paused search                                       |
| `GET /saved-searches/:id/new-results`  | the unseen matches as feed cards; opening them marks them seen and counts as opening the search  |
| `GET /analytics/unmet-demand`          | tenant admins and platform staff; read-only JSON                                                 |

- **`frequency`:** `instant` | `daily` | `off`. With `off` the search still matches, so the badge and list work, but it
  never sends a notification.
- **Validation:** a saved search is checked exactly as `GET /search` checks the same parameters:
  - the category exists;
  - the field filters fit its current schema;
  - the radius is at most `search_max_radius_km`.

## Decisions

**1. One matcher.** "Does this post match these filters" has exactly one implementation, shared by search and saved
searches:

| Piece                   | What it does                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SearchCriteriaService` | turns a request or a stored search into `SearchCriteria`: the category tree, `parseFieldFilters` against the schema, the feed's scopes and radius caps, and the price in poisha |
| `SearchMatcher`         | compiles criteria into the engine filter (the only caller of `buildSearchFilter`) and answers which ids match every filter and every word (`matchingIds` / `matchEach`)         |

- **Who calls it:**
  - `GET /search` uses it for its filters and for the text selection of an explicit sort (ADR 040);
  - the saved-search matcher asks `matchEach` the same question, restricted to each search's candidates.
- **The one translation:** `savedSearchCriteriaInput()` turns a stored row into the same input a request produces, as a
  nearby search around its centre.
- **How it is enforced:**
  - `architecture/single-matcher.spec.ts` fails if saved-search code ever compiles filters, parses field filters, calls
    the engine or uses the SQL evaluators itself;
  - the matcher spec asserts the engine receives the same filter from both paths;
  - the e2e test checks that `GET /search` and the saved search agree on real posts.
- **Out of scope:** the Postgres fallback of search (degraded mode, ADR 025) and the feed's SQL `post_field_filter_matches`
  are separate. Neither is used for alerts.

**2. The matcher is a scheduled job, never part of publishing.** `match-saved-searches` runs every 5 minutes through
`JobRunner`. Per tenant:

1. **Batch:** a watermark `(published_at, id)` in `saved_search_watermarks` walks the tenant's live posts in order. A
   post counts once it has been live for `saved_search_match_grace_seconds`, by which time the outbox relay has indexed
   it. A tenant seen for the first time starts at "now", so there is no flood from the back catalogue.
2. **Candidates:** PostGIS finds the active searches whose circle holds each post, minus the author's own. It uses the
   same point the index uses (pin, else locality centre, else area centroid). This is only a narrowing.
3. **Decision:** `SearchMatcher.matchEach`, one multi-search entry per search, each with `id IN [its candidates]`.
4. **Record:** matches go into `saved_search_matches` (idempotent), then the watermark moves.

If the engine is down, the batch fails before the watermark moves and the next run retries it. There is no other way to
match to fall back on.

A search whose filters no longer fit its category (the schema changed, or the category was removed) is skipped and
logged, never half-matched.

**3. One notification per search, however many posts matched.** In the same run, the notifier sends each search with
new, unnotified matches a single `saved_search_match` notification. Its params are `savedSearchId`, `name` and `count`,
and it deep-links to `/saved-searches/:id`. When it goes out is `notification-policy.ts`:

- **`instant`:** whenever the cap allows.
- **`daily`:** once per Dhaka day, from `saved_search_daily_digest_hour`.
- **The cap:** at most `saved_search_notify_per_day` per search per Asia/Dhaka day, counted in
  `saved_searches.notify_day` / `notify_count`.
- **Matches over the cap** keep showing as new results and in the badge. They go out, grouped, in the next allowed
  notification.
- **Marking:** a match is marked notified only after a channel delivered it. The dedupe key `(search, newest match)`
  keeps a retry from notifying twice.

**4. Channels are pluggable.** The notifier calls `NotificationService`, which delivers through every registered
`NotificationChannel`.

- **Now:** `InAppNotificationChannel` writes the inbox row.
- **The badge and the "new results" list:** `saved_search_matches` (unseen rows) plus
  `GET /saved-searches/:id/new-results`.
- **Week 11:** push, SMS and email register as more channels under `NOTIFICATION_CHANNELS`. Nothing in saved searches
  changes.

**5. New results stay honest.**

- **Cards:** the list is read as feed cards in each post's own tenant (`FeedService.cardsFor`), so a card shows only
  what that tenant makes public.
- **A post that stops being live** (sold, removed, hidden, deleted) drops its unseen matches, by trigger, so the badge
  never counts something that can't be opened.
- **A scrubbed post** drops all its matches (ADR 006).

**6. Limits.**

- **`saved_search_max_active`:** active means switched on, not paused and not deleted. It is checked on create and on
  resume, under a per-user advisory lock, so two parallel requests can't both take the last slot. Over the limit
  answers 409 `SAVED_SEARCH_LIMIT_REACHED`.
- **Name and radius:** `saved_search_name_max_length`, and the radius at most `search_max_radius_km`.

**7. Auto-pause.**

- **What it does:** the nightly `pause-idle-saved-searches` job pauses active searches not opened for
  `saved_search_auto_pause_days` (0 = never) and sends a final `saved_search_paused` notice (`idleDays`).
- **What counts as opened:** creating, changing, or opening the new results (`last_engaged_at`).
- **While paused:** the search matches and notifies nothing.
- **Resuming:** `PATCH { active: true }` resumes it, subject to the active limit again.

**8. Unmet demand is a materialized view.**

- **What it counts:** `unmet_demand`, per tenant × category × geo_area (the finest area holding the point):
  - active saved searches;
  - searches of the last `unmet_demand_window_days` that found fewer than `unmet_demand_result_threshold` results.
- **Who owns what:** a saved search belongs to the tenant owning its centre (`resolve_owning_tenant`, 0023), and a
  search to the tenant it was made in.
- **What the search log adds:** `search_queries` gains `category_id` and `origin`. The origin is rounded to
  `search_log_origin_decimals`, and stored only when the viewer shared a location, since the tenant's centre would skew
  the areas.
- **Settings take effect on refresh:** the view reads its settings at every refresh, so a change applies from the next
  one.
- **Refresh:** `refresh-unmet-demand` runs hourly, `REFRESH … CONCURRENTLY` (readers never wait).
- **No RLS on a view:**
  - nobody reads it directly;
  - `unmet_demand_for_tenant()` (SECURITY DEFINER) serves the current tenant's rows to tenant admins and platform staff;
  - the API refuses other roles with a typed 403, since a marketer also holds `analytics:read`;
  - `refresh_unmet_demand()` is system only.

## Settings (0035)

| Setting                                                                      | Default    |
| ---------------------------------------------------------------------------- | ---------- |
| `saved_search_match_grace_seconds`                                           | 60         |
| `saved_search_daily_digest_hour`                                             | 9          |
| `saved_search_new_results_max`                                               | 50         |
| `saved_search_name_max_length`                                               | 80         |
| `unmet_demand_result_threshold`                                              | 3          |
| `unmet_demand_window_days`                                                   | 30         |
| `search_log_origin_decimals`                                                 | 2          |
| existing: `saved_search_max_active` / `_notify_per_day` / `_auto_pause_days` | 5 / 1 / 30 |

## Consequences

- **After deploying:** run the worker; `match-saved-searches` sets each tenant's watermark on its first run.
- **Alert delay:** an instant alert arrives at most about 5 minutes plus the grace period after publication.
- **Tests:**
  - unit: the notification policy, grouping, the cap, auto-pause, the limits, and matcher equivalence with search;
  - architecture: `single-matcher.spec.ts`;
  - DB: `saved-searches.db-spec.ts`, for RLS, the triggers and the view's access and counts;
  - e2e: `saved-searches.e2e-spec.ts`, with Postgres, Redis and Meilisearch.
- **Known limits:**
  - A post approved after the watermark passed its `published_at` is not matched. This assumes `published_at` is set
    when a post goes live.
  - `saved_search_matches` has no retention purge yet, and neither does `search_queries` (ADR 040).
  - `GET /analytics/unmet-demand` sits at `/analytics`, as specified, while the other tenant analytics live under
    `/tenant/analytics`.

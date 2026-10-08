# Month 2 review: repo audit before Month 3

Audited 2026-10-07 against the working tree on `main`, HEAD `914861e` plus the uncommitted Month 2 tail (places
reporting, notification inbox, saved list, and this review's fixes). The review also **changed code**. Each fix is
listed in "Fixed during this review" and marked _fixed_ where it comes up below.

Measured on the dev laptop (WSL, about 3–4× slower than a server; see `local-test-stack` notes) with local Postgres
16 + PostGIS, Redis and Meilisearch 1.8.

## Fixed during this review

| Fix                                                                                                                                                                                    | Why it mattered                                                                                                                                                                                                                        | Where                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **`map_features()` computed `is_open_at()` for every place, store and emergency contact in the box on every request**, `open_now` or not.                                              | It was the map's main cost: about 900 `is_open_at` calls per request and 1.6–2.5 s per tile request at 30k posts / 3k places. After the fix: z12 **1,583 → 32 ms**, z14 **2,486 → 50 ms**, z16 475 → 96 ms, `open_now` 2,251 → 433 ms. | `0048_map_and_heatmap_consistency`, new test in `map-features.db-spec.ts`                                |
| The map showed a live post past `expires_at` for up to 15 minutes, until the expiry job swept it; the feed already hid it. Same in heatmap supply and the map preview.                 | Two surfaces disagreed about the same post.                                                                                                                                                                                            | 0048, `map-preview.repository.ts`, tests in `map-features.db-spec.ts` and `heatmap.db-spec.ts`           |
| The heatmap assigned saved searches to a tenant by polygon (`st_covers`). Unmet demand, ownership and every other surface use `resolve_owning_tenant()` (buffer, radius-mode tenants). | The same saved search could count for different tenants in the two admin reports.                                                                                                                                                      | 0048, test in `heatmap.db-spec.ts`                                                                       |
| The offline-map cut ignored radius-mode tenants' service radius.                                                                                                                       | A radius-mode tenant's download would miss most of its area.                                                                                                                                                                           | `offline-map.repository.ts`, test in `offline-map.e2e-spec.ts`                                           |
| The mobile and web photo pickers hardcoded 10 photos and 1200 px. Open since Month 1.                                                                                                  | Changing `post_max_media` or `media_variant_full_px` would have desynced the clients from the API.                                                                                                                                     | `GET /tenant/config` now carries `media`; mobile `upload_queue.dart`, web `editor-tenant.ts`, with tests |
| `post-field-filters.db-spec.ts` left 200,000 unprocessed search outbox events behind.                                                                                                  | The next suite that relays (saved searches, search) drained them inside its 30 s timeout: the "flaky" saved-searches e2e failures in three of the last four full runs.                                                                 | test cleanup                                                                                             |
| `OfflineMapController` wrote state after its provider was disposed (area change mid-download).                                                                                         | It threw in the app; the test showed "Cannot use the Ref … after it has been disposed".                                                                                                                                                | `offline_map_controller.dart`                                                                            |
| Socket tests used a bare `Dio()` with no timeouts.                                                                                                                                     | A missed close hung a test for 2 minutes instead of retrying, as the app does.                                                                                                                                                         | `offline_map_test_support.dart`                                                                          |
| No screen listed saved items. Week 6 shipped the API (`GET /saved`) only.                                                                                                              | Users could save but never see what they saved.                                                                                                                                                                                        | mobile `features/saved/`, Profile → "সেভ করা", with tests                                                |
| 10 Month 2 tables were missing from `schema.md`.                                                                                                                                       | The spec didn't describe the schema.                                                                                                                                                                                                   | `schema.md` §13A                                                                                         |

## Closed after the review (0049)

The review's open items, worked through the same day:

| Gap (section)                                                                   | What changed                                                                                                                                                                                                                                                                                                                                                                                        | Proof                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `open_now` on the map still cost ~2.4 ms per candidate (§9 #1)                  | The cause was an index, not the function. `is_open_at` looks hours up by place or store id, but every hours index started with `tenant_id`, so each call scanned all of `place_hours`. Entity-first indexes: one call **1.67 → 0.43 ms**; the map's `open_now` on the same 0.06° box **2,556 → 715 ms**. Still one open/closed implementation.                                                      | `0049`, `hours.db-spec.ts` (index usable for each lookup)                                           |
| Visibility written out ~15 times (§6)                                           | `post_is_listed()` / `post_is_viewable()`: inlined SQL functions (partial indexes still match, checked with EXPLAIN). `feed_posts`, `map_features`, `heatmap_cells` and `discover_nearby` (which also now drops expired posts) and every API query use them. `listed` also excludes privacy-scrubbed posts: a scrub empties a post without changing its status.                                     | `single-visibility-rule.spec.ts`, `post-visibility.db-spec.ts`, `cross-tenant-discovery.db-spec.ts` |
| Search kept a post up to 15 min past `expires_at` (§6)                          | Documents carry `expires_at`; every search filters on it. Documents indexed earlier have no field and still match until resynced.                                                                                                                                                                                                                                                                   | `filter-builder.spec.ts`, `search.meili-spec.ts`                                                    |
| Field filters: two SQL implementations (§6)                                     | The search fallback's JSON-path ranges call the feed's `post_field_filter_matches()`. Only the index-serving shapes (generated columns, containment) are built in TS.                                                                                                                                                                                                                               | `field-filter-parity.db-spec.ts`: 14 cases, wrong-type values included, both paths equal            |
| Tenant area geometry three times (§6)                                           | `tenant_area_distance_m()`, used by `nearest_tenants`, `tenant_distance_m` and `tenant_covers_point`.                                                                                                                                                                                                                                                                                               | `locations.db-spec.ts`                                                                              |
| `map_style_fallback` could bypass the Barikoi budget (§7)                       | Retired: setting, DTO field and client code. Without our tiles the map says it is unavailable.                                                                                                                                                                                                                                                                                                      | ADR 043 updated                                                                                     |
| Client copies of server numbers (§6, §8)                                        | `GET /tenant/config` adds `media.imageQuality`, `timezone` (name + current UTC offset), `search.suggestMinChars`, `places.duplicateReportRadiusM` and `client.configRefreshMinutes`. The app's date validator, compressor, twin picker and config cache use them; the web's compressor and search box too. The app caches them (Drift v4). Its config used to be served from cache without `media`. | `tenants.e2e-spec.ts`, `validation_context_test.dart`, `editor-tenant.test.ts`                      |
| Schedulers each declared `Asia/Dhaka` (§6)                                      | One `SCHEDULE_TIMEZONE` (`common/schedule-timezone.ts`), the saved-search daily cap included.                                                                                                                                                                                                                                                                                                       | -                                                                                                   |
| `DESCRIPTION_MAX_CHARS`, `search_suggest_limit` (§8)                            | `search_description_max_chars` setting; the unused `search_suggest_limit` is retired.                                                                                                                                                                                                                                                                                                               | settings parity spec                                                                                |
| No place screen: saved places, place notifications and claims led nowhere (§12) | `/places/:id` in the app: open state, week, call, directions, save, report, suggest. The saved list, the inbox (`/places/…` deep links) and the map preview open it. The report flow is now shared with the map.                                                                                                                                                                                    | `place_detail_screen_test.dart`, `notifications_test.dart`                                          |
| Leaked fixtures made other suites time out (§12 risk 5)                         | The DB run fails at teardown when more than 5,000 outbox events are left unprocessed, naming the table.                                                                                                                                                                                                                                                                                             | `test/db/global-teardown.ts`                                                                        |
| Android release signing (TL;DR)                                                 | `key.properties` or `ANDROID_KEYSTORE_*` in CI; `bundleRelease` refuses to build debug-signed. Steps in `apps/mobile/README.md`. **Not built here** (no Android SDK on this machine): first real release build verifies it.                                                                                                                                                                         | -                                                                                                   |

**Looked at, no change needed:**

- `PERMISSIONS_CACHE_TTL_MS`: every role and matrix change already invalidates the cache (`roles.service.ts`), so
  the 5 minutes only bound a missed path.
- `docs/decisions/043/` isn't stray: ADR 043 links its screenshots.
- **Feed "nearby" candidate cap (§9 #2): not added.** `feed_posts` already skips the trust lookup with an exact bound.
  A candidate cap would make ranking approximate and drop posts from deep pages. At 30k posts it is ~87 ms here
  (~25 ms on a server). Revisit with the p95 budgets of risk 3.

**Full run after 0049:**

- API: typecheck and lint clean, unit 877, DB 631, search (Meilisearch) 46, e2e 261.
- Admin 54, web 87, Flutter 277; all pass.
- The search suite had been failing since the open-now commit. Its fake repository lacked `openStates`, and the
  regression script didn't run `test:search`; it does now.

**Then (same day):**

- **SMS gateway: BulkSMSBD** (ADR 053), chosen by the product owner.
  - `SMS_PROVIDER=bulksmsbd` sends OTPs through it, with a timeout, one retry and typed failures
    (`SMS_DELIVERY_FAILED`, worded in Bengali in the app and on the web).
  - The API refuses to start in production on the logging-only provider.
  - What is left is operations: open the account, get a sender ID, whitelist the server IP.
- **Web visitors can save a post** ("সেভ করুন" on the listing page, Playwright-tested).
- **The e2e stub's types were stale since the open-now change** (`openState`, `open_state`, `fallbackStyleUrl`).
  Fixed.

**Still open:** real geo usage data (needs a deployment), and the BulkSMSBD account itself (ADR 053, "Setting it
up").

## TL;DR

Month 2 delivered every item in the weeks 5–9 plan, and the test suites are real now (API DB + e2e + Flutter run on
every change, in CI too). The review's measurements found one serious performance bug (the map) and three places where
the same rule had drifted between surfaces. All four are fixed above.

What is left is mostly what Month 1 already flagged and nobody owned:

- **No production SMS gateway.** Phone login can't work outside dev. _Closed: BulkSMSBD (ADR 053); the account is
  still to open._
- **The Android app was still debug-signed.** _Closed (0049 follow-up):_ release signing from `key.properties`, not yet
  built on a real SDK.
- **No real usage data exists.** There is no deployment and no pilot, so the geo cost section is a projection, not a
  measurement.

---

## 1. What exists and works

"Works" means typecheck, lint and the unit, DB and e2e suites pass (§4), against real Postgres, Redis and Meilisearch.

### apps/api: Month 2 modules

| Module                            | What's there                                                                                                                                                     | State                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `posts`                           | One state machine; owning-tenant context via `resolve_owning_tenant`; idempotent create; edit and resubmit; lifecycle jobs (expire, remind, renew, stale drafts) | Works                                           |
| `moderation`, `trust`             | Trust score (now with `approved_edits`), pre-filter, queue, approve/reject/remove/hard-remove (`scrub_post`, legal holds)                                        | Works                                           |
| `feed`                            | `feed_posts`/`feed_stores`/`feed_landmarks` ranking, cursor paging, open-now, cache by geohash cell                                                              | Works; see §8 (cost grows with posts in radius) |
| `engagement`, `saved`             | Post detail, views, contact reveal + leads, reports, share links, saved posts/places/stores, follows                                                             | Works                                           |
| `search`, `saved-searches`, `seo` | Meilisearch search with Banglish/transliteration, suggestions, trending, saved searches + matcher + notifier, unmet demand, SEO landing pages                    | Works                                           |
| `map`, `locations`                | Self-hosted PMTiles, Barikoi behind `GeoProvider` with budget + cache, `map_features` clustering, previews, distance/route, offline maps                         | Works (fixed above)                             |
| `places`, `hours`                 | Contributions, revisions + revert, claims, duplicates + merge/undo, reports, edit suggestions, business hours + open-now                                         | Works                                           |
| `analytics`                       | Unmet demand, heatmap, store activity                                                                                                                            | Works                                           |
| `notifications`                   | In-app channel + inbox (`GET /notifications`)                                                                                                                    | Works                                           |
| `jobs`                            | Job runner with run records, locks, batch caps; platform health view                                                                                             | Works                                           |

Migrations: **49** (0000–0048), each with a journal entry and snapshot. Month 2 added 0022–0048. None drops or renames
a column.

### Clients

- **Mobile (Flutter):**
  - Feed with filters, search (Banglish, suggestions, saved searches), post detail (call, WhatsApp, save, report,
    share), post stepper with drafts and offline queue, my posts, Map tab + LocationPicker, offline map area, place
    report/suggest.
  - New in this review: notification inbox and saved list.
- **Web:** public listing pages and SEO, search, area landing pages, map at parity, seller sign-in and posting.
  Visitors can't save posts on the web (no save button) — a product gap, not a bug.
- **Admin:** moderation (Posts and Places tabs), heatmap, roles, tenants.

---

## 2. Month 2 plan items

| Week | Item                                                                                           | Status                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 5    | Posts, moderation, lifecycle                                                                   | ✅                                                                                           |
| 6    | Feed ranking, post detail, contact actions, lead tracking                                      | ✅                                                                                           |
| 6    | Saved items                                                                                    | ✅ API; ⚠️ the list screen was missing until this review (mobile now; web can't save at all) |
| 7    | Search UX, suggestions, saved searches (in-app), unmet demand                                  | ✅                                                                                           |
| 8    | Self-hosted OSM tiles, Barikoi behind our API, geo query layer, server clustering, map screens | ✅ (map cost fixed above)                                                                    |
| 9    | Place marking, claims, duplicates, open-now, offline area, admin heatmap, map moderation       | ✅                                                                                           |
| —    | Notification inbox                                                                             | ✅ added; nothing read `notifications` before                                                |
| —    | Real SMS gateway, Android release config                                                       | ❌ still open since Month 1                                                                  |

---

## 3. TODO / FIXME / skipped / stubbed

- **TODO:** only the two Android ones from Month 1 (`build.gradle.kts:18` application ID, `:31` release signing). Other
  `XXX` hits are phone-number hints (`01XXXXXXXXX`).
- **Skipped tests:** none (no `.skip`, `.only`, `.todo`, `xit`).
- **Stubs:** `BdGatewaySmsProvider` still throws `SMS_PROVIDER_NOT_CONFIGURED` (_replaced by BulkSMSBD, ADR 053_); dev
  uses `LocalSmsProvider`, which logs the OTP. The Playwright suite still runs against the stub API.
- **Docs:** a stray `docs/decisions/043` directory sits beside `043-self-hosted-pmtiles-basemap.md`.

---

## 4. Tests

| Suite                           | Result (2026-10-07, full serial run)   |
| ------------------------------- | -------------------------------------- |
| API typecheck / lint            | ✅ / ✅                                |
| API unit                        | ✅ 873/873                             |
| API DB (`test:db`)              | ✅ 612/612                             |
| API e2e (`test:e2e`)            | ✅ 261/261                             |
| Admin typecheck / lint / vitest | ✅ / ✅ / 54                           |
| Web typecheck / lint / vitest   | ✅ / ✅ / 87                           |
| Flutter analyze / test          | ✅ no issues / 266/266                 |
| Playwright                      | not run (stub API; needs its own pass) |

This is the first full serial run where every suite passed; the previous three full runs each had saved-searches or
Flutter offline-map failures (both root-caused and fixed, see the top table).

Notes:

- **The "flaky" saved-searches e2e was a test-hygiene bug, now fixed.** A DB spec left 200k outbox events behind (see
  "Fixed during this review").
- The full regression must run suites **one after another**. In parallel, every suite on this laptop times out. CI runs
  them in separate jobs.

---

## 5. `scripts/audit-schema.sql`

**Run against the fully migrated test DB (49 migrations): all 7 checks return 0 rows.**

That covers missing RLS, unspecified `ON DELETE`, float money, `timestamp` without time zone, geography without GiST,
status/deletion enum overlap, and purge functions without a legal-hold check.

The legal-hold check only sees DB functions, so the TS paths were checked by hand:

- **Check `legal_hold_blocks`:** media purge, stale-draft cleanup and moderation.
- **Fine without it:** the other deletes are system logs (`geo_provider_calls`, outbox) or soft deletes (place merge).

---

## 6. The same logic in more than one place

The rule: one implementation each. ✅ = one implementation; ⚠️ = more than one, with how to get to one.

### Open-now ✅

`is_open_at(entity_type, id, at)` (0044) is the only implementation:

- map, feed, search and place detail call it (directly or via `open_states`/`open_ids_near`);
- the old Dhaka-only copies in 0039–0041 were replaced;
- no client computes open state.

### Tenant assignment (which tenant owns a point) ⚠️ → ✅ (0049: `tenant_area_distance_m`)

- **The canonical rule** is `resolve_owning_tenant()` (0023), built on `nearest_tenants()` (0021, which knows radius-mode
  tenants and the buffer). Posts, places and place suggestions use it through `PostOwnershipService.resolve`, and unmet
  demand uses it for saved searches.
- _Fixed:_ the heatmap used `st_covers(polygon)`, and the offline-map cut ignored radius mode.
- **Still a second rule:**
  - `tenant_covers_point()` (0021) is a strict in-or-out test. It's consistent with `nearest_tenants` (same modes), but
    it's a second function.
  - `search_queries.tenant_id` is the tenant the search was _made in_, not the owner of its origin. That is defensible
    (it's the request's tenant), but it differs from saved searches.
- **To get to one:** keep `nearest_tenants()` as the only geometry, express `tenant_covers_point()` as
  `nearest_tenants(...).inside`, and record the "query tenant = request tenant" decision in ADR 041.

### Visibility (is this post public?) ⚠️ → ✅ (0049: `post_is_listed` / `post_is_viewable`)

The predicate `status_code = 'live' AND deleted_at IS NULL AND NOT hidden_by_owner` is written out about **15 times**:

- **SQL** (11 migrations): `feed_posts`, `map_features`, `discover_nearby`, `heatmap_cells`, the SEO and saved-item
  views, the unmet-demand trigger, and the partial indexes in 0005;
- **TypeScript:** `post-visibility.ts` for detail, the search fallback, the map preview, the search documents
  repository.

The copies differ:

- **Expiry:** only the feed and the search fallback checked `expires_at`. _Fixed_ for the map, map preview and heatmap;
  `discover_nearby` (0023, unused by the app now) and the Meilisearch index still rely on the 15-minute expiry job.
- **Sold:** detail and SEO show `sold` posts, while discovery shows only `live`. That one is intended (sold stays
  visible on its own page).
- **Scrubbed:** the search fallback also checks `scrubbed_at`; the others rely on `scrub_post` changing the status.

**To get to one:** a single SQL function, `post_is_listed(status, deleted_at, hidden, expires_at, at)`, `IMMUTABLE`
and inlinable, used by every SQL surface. The TS paths would call it through the SQL they already send. The risk is the
partial indexes: the planner must still match them after inlining. Check with EXPLAIN on `feed_posts` and
`map_features` before switching.

### Filtering (post field filters) ⚠️ → ✅ (0049: one SQL matcher, parity test)

Three implementations of the same semantics (`eq`/`gte`/`lte`/`in` on a category's fields):

1. `search/query/filter-builder.ts`: the Meilisearch filter string (search, saved searches, SEO). The
   `single-matcher.spec.ts` architecture test keeps it to one caller.
2. `post_field_filter_matches()` (0030): SQL over `posts.fields`, used by `feed_posts`.
3. `categories/post-field-filters.ts`: SQL built in TS, used by the search fallback (`search-query.repository.ts`). It
   uses the generated columns (`price`, `bedrooms`, …) for index range scans.

1 is unavoidable (a different engine), but 2 and 3 are the same thing twice inside Postgres.

**To get to one:**

- make 3 the SQL source and have `feed_posts` take its compiled condition (the feed builds its SQL in TS already), or
  make 3 call 2 for non-generated fields;
- add a table-driven test that runs the same filter cases through all three and compares the ids.

### Timezone / "today" ⚠️ → ✅ (0049: tenant offset in config, one schedule constant)

- Business hours use `tenants.timezone`; the server's date validation (`x-not-before-today`) uses the tenant's
  timezone.
- But the **mobile date validator hardcodes UTC+6** (`field_validator.dart:62`).
- And six schedulers each declare `SCHEDULE_TIMEZONE = 'Asia/Dhaka'`; the saved-search daily cap counts "Asia/Dhaka
  days".

All Bangladeshi tenants are Asia/Dhaka today, so nothing is wrong yet. To get to one: a single constant for job
schedules, and the client takes "today" from `tenant/config`.

### Client copies of server limits ⚠️ → ✅ (0049)

- _Fixed:_ photos per post and image size now come from `tenant/config`.
- **Still copied:**
  - webp quality 80 (no setting);
  - web search `MIN_CHARS = 2` (copies `search_suggest_min_chars`);
  - the mobile duplicate-report twin search box of about 500 m (`_twinSearchDegrees`), where the server allows
    `duplicate_report_radius_m` = 1000 m.

---

## 7. Geo cost review

### What could be measured: nothing real

- No deployment or pilot exists, and this machine can't reach the developer's dev database: the Postgres on 5432
  rejects the `.env` credentials, and Docker isn't integrated into this WSL distro.
- The test database's `geo_provider_calls` only has 7 rows from tests.

**So there are no per-day Barikoi counts, no cache hit rate and no calls-per-active-user from real use.** Run these on
the dev or staging database (the API logs every call and every cache hit in `geo_provider_calls`, 0039):

```sql
-- Calls per day (as Barikoi bills them) and cache hit rate, last 30 days
SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Dhaka')::date AS day,
       sum(calls_counted) FILTER (WHERE NOT cache_hit)            AS billed_calls,
       count(*) FILTER (WHERE cache_hit)::float / count(*)          AS cache_hit_rate,
       count(*) FILTER (WHERE status = 'over_budget')               AS refused_over_budget
FROM geo_provider_calls
WHERE created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1;

-- Calls per active user: billed calls ÷ distinct users who opened the app that day
-- (users who sent any request; use auth sessions or post_views for "active").
```

`GET /analytics/geo-usage` (platform staff, up to `geo_usage_report_days_max` days) serves the same numbers.

### Projection from the cost model in code (assumptions, not data)

Costs are settings (0039):

| Action          | Calls each                                               |
| --------------- | -------------------------------------------------------- |
| Autocomplete    | 1                                                        |
| Reverse geocode | 1 + 1 per field (post location asks only `bangla`, so 2) |
| Route           | 2                                                        |
| Rupantor        | 2                                                        |

How often each is avoided:

- **Reverse:** cached by geohash-7 (~150 m) for 24 h.
- **Autocomplete:** skipped when our own data gives ≥ 3 results (`geo_own_results_min`).
- **Route:** only on an explicit tap, cached per session.

Assumed per active user per day:

- 5 % post, 1.5 pin stops → 0.15 calls;
- 10 % search an address, 2 queries, half reach Barikoi → 0.10;
- 3 % ask "রাস্তায় কত দূর?" → 0.06.

That gives **≈ 0.31 calls before cache, ≈ 0.22 after a 30 % hit rate.**

| Active users per day | Billed calls/day | Per 30-day month | vs `barikoi_daily_call_budget` = 1,000/day (30,000/month) |
| -------------------- | ---------------- | ---------------- | --------------------------------------------------------- |
| 500                  | ~110             | ~3,300           | 11 %                                                      |
| 2,000                | ~440             | ~13,200          | 44 %                                                      |
| 4,500                | ~1,000           | ~30,000          | at the budget; then graceful fallback                     |

**Our plan's real limit isn't recorded anywhere in the repo.** `barikoi_daily_call_budget` is our own cap. Put the
contracted monthly quota in ADR 044 and size the budget from it.

### Client code that reaches Barikoi or a public OSM server directly

- **None found.** Clients only talk to our API. The architecture test `geo-provider-boundary.spec.ts` keeps Barikoi
  behind `GeoProvider`.
- Tiles, glyphs and sprites come from our own `/tiles`, and OpenStreetMap appears only in attribution text.
- **One trap** (_closed in 0049: the setting is retired_):
  - The emergency setting `map_style_fallback` (empty by default) would make **clients load a Barikoi style directly**.
    That is 4 billed calls per map load, **not counted** in `geo_provider_calls`, with the key in a client-visible URL.
    This contradicts CLAUDE.md's map rules.
  - Either delete the setting or make the API proxy it.
- Google Maps directions is a user-initiated hand-off to the Google app or web, not a tile or geocoding call.

---

## 8. Numbers in business logic that should be settings

`no-hardcoded-numbers.spec.ts` passes (226 `settings-exempt` markers). It scans only TypeScript literals in
`apps/api/src`, so its blind spots were scanned separately:

- **Numbers inside SQL strings in the API:** clean (unit conversions, numeric precision, admin level 3 = upazila).
- **SQL function bodies (0026–0048):** clean. Tile maths (256, 85.05…), validation ranges, and a 16-hop guard in
  `place_redirect_target`. No hardcoded intervals.

**Flagged** (_0049 closed every row but the cron strings, the job timezone (now one constant) and
`PERMISSIONS_CACHE_TTL_MS` (invalidated on every change, see above)_):

| Where                                                                | Value                                    | Why                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `posts-schedule.ts` and the other `*-schedule.ts` files              | cron strings, e.g. expiry `*/15 * * * *` | Expiry frequency decides how long an expired post stays in search (§6). A behaviour, not infra. |
| six `*-schedule.ts` / processors                                     | `SCHEDULE_TIMEZONE = 'Asia/Dhaka'`       | Duplicated constant (§6).                                                                       |
| `media_upload/.../image_compressor.dart:12`, web `compress-image.ts` | webp quality 80                          | No setting; image quality versus data cost.                                                     |
| web `components/search/search-box.tsx:31`                            | `MIN_CHARS = 2`                          | Copies `search_suggest_min_chars`.                                                              |
| mobile `place_report_sheet.dart`                                     | twin search ~500 m, 8 shown              | Should follow `duplicate_report_radius_m`.                                                      |
| mobile `field_validator.dart:62`                                     | UTC+6                                    | Tenant timezone (§6).                                                                           |
| mobile `tenant_repository.dart:18`                                   | tenant config cache 24 h                 | Config changes (limits, flags) reach phones a day late.                                         |
| `env.schema.ts` (exempt folder)                                      | `PERMISSIONS_CACHE_TTL_MS` 5 min         | Still open from Month 1: a revoked role works for up to 5 min.                                  |
| `search/documents/document-builder.ts`                               | `DESCRIPTION_MAX_CHARS = 2000`           | Decides what is searchable.                                                                     |

**Unused settings:**

- `search_suggest_limit` is seeded and registered but read by no code.
- Month 3+ keys (billing, appeals, retention) are seeded ahead of their code, which is expected.

`map_tiles_max_zoom` _is_ used, by `scripts/map/build-tiles.sh`.

---

## 9. Query performance

### Method

- **Database:** a copy of the test DB, seeded, then scaled to a pilot thana: **30,530 posts, 3,020 places (10,353
  opening-hours rows), 50,060 search queries** over 30 days.
- **Workload:** the real API drove 60 rounds of feed, search, suggest, map (z12/14/16, open_now), post and place detail,
  previews, distance, tenant lookup, the five moderation queues, both heatmaps, unmet demand, notifications and tenant
  config.
- **Measurement:** `pg_stat_statements` (`track = all`) for the ranking, then `auto_explain` (`log_analyze`,
  `log_nested_statements`, `log_buffers`) replayed the same calls, so plans are **EXPLAIN ANALYZE of the real calls with
  their real parameters**, including the statements inside functions.

### The 10 slowest statements (after the 0048 fix)

| #   | Statement                                  | Calls | Mean     | Max      | Index use (EXPLAIN ANALYZE)                                                                                                                                                                      |
| --- | ------------------------------------------ | ----- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `map_features(...)`                        | 91    | 368 ms   | 1,435 ms | ✅ `places_location_gist_idx` (bitmap, 824 rows), PK lookups. All the time left is the `open_now` calls: `is_open_at` once per candidate (~2.4 ms each). Without `open_now`: 32–96 ms.           |
| 2   | `feed_posts(...)` scope=nearby             | 77    | 87 ms    | 569 ms   | ✅ `posts_location_gist_idx` (bitmap, 23k rows in radius). Then **all ~20k eligible posts are scored** before the top 20 (CTE scans of 20k rows); planner estimate rows=1 against 20,114 actual. |
| 3   | `heatmap_cells('demand',...)`              | 40    | 55 ms    | 81 ms    | ⚠️ Seq scan on `search_queries` (25k of 50k rows match). The `(tenant_id, created_at)` index exists; at 2 tenants the planner rightly skips it, at many tenants it will use it.                  |
| 4   | `search_popular_queries(...)` (trending)   | 1–2   | 51–82 ms | 106 ms   | ✅ `search_queries_tenant_created_idx` (bitmap, 25k rows), then a group-by over them.                                                                                                            |
| 5   | `feed_posts(...)` scope=area               | 100   | 36 ms    | 90 ms    | ✅ same as #2, fewer posts in the area.                                                                                                                                                          |
| 6   | `open_states('place', [id])`               | 60    | 4.2 ms   | 7 ms     | ✅ PK; `hours_intervals` is the cost (~2.4 ms per entity).                                                                                                                                       |
| 7   | post detail: seller block                  | 60    | 2.2 ms   | 20 ms    | ✅ PK/FK lookups.                                                                                                                                                                                |
| 8   | `select key, value from platform_settings` | 2     | 2.0 ms   | 3.7 ms   | Seq scan of 260 rows: the settings cache load, fine.                                                                                                                                             |
| 9   | `feed_landmarks(...)`                      | 117   | 1.6 ms   | 27 ms    | ✅ GiST on places.                                                                                                                                                                               |
| 10  | tenants nearby                             | 60    | 1.2 ms   | 7 ms     | Seq scan on `tenants` (4 rows): fine at this count, needs the GiST path at hundreds.                                                                                                             |

**Before 0048, #1 was `map_features` at 2,572 ms mean (max 8,591 ms):**

- `hours_intervals` ran 98,667 times for 162 map requests;
- the EXPLAIN showed `Result (actual time=5.68 ms, loops=714)`, i.e. one `is_open_at` per place in the box, ~4.1 s of
  a 4.4 s call.

**What to do next:**

- **`open_now` on the map:** compute today's intervals once per request set-based (one query over `place_hours` +
  exceptions for all candidate ids), or keep a per-entity "open intervals today" row refreshed by a job. Either removes
  the per-row function call.
- **Feed nearby:**
  - cap candidates before scoring (nearest N by distance, or a recency floor), so cost stays flat as a thana grows;
  - fix the rows=1 estimate (set the function's `ROWS`, or rewrite the CTE chain) so the planner sizes joins right.
- **`tenants nearby`:** fine until there are many tenants.

---

## 10. Phone walkthrough: by hand, on a real phone

**Goal:** install → pick area → browse feed → filter → search in Banglish → open detail → call → save → post a listing
with photos → see it in moderation → approve → see it live on the map → mark it sold.

### Before you start (on the PC)

1. **One Wi-Fi.** PC and phone on the same Wi-Fi; note the PC's LAN IP (`ipconfig` → IPv4, e.g. `192.168.0.105`).
   Allow port 3000 through the Windows firewall.
2. **Data.** Database and services up (dev docker stack, or `local-test-stack`); `.env` with `SMS_PROVIDER=local`. Then:

   ```sh
   pnpm --filter @amar-elaka/api db:migrate
   pnpm --filter @amar-elaka/api db:seed      # Mirpur + Trishal, users +8801700000001…05, 30 posts, 20 places
   pnpm --filter @amar-elaka/api search:reindex
   ```

3. **Base map.** `scripts/map/build-tiles.sh --maxzoom 14` (needs the `pmtiles` CLI). Without it the map shows "map
   unavailable", but the list view and pins still work.
4. **API and worker.** The worker relays search updates and runs the jobs; without it a new post never reaches search
   or the map's cache:

   ```sh
   pnpm --filter @amar-elaka/api dev                                      # API on :3000 (0.0.0.0)
   pnpm --filter @amar-elaka/api build && node apps/api/dist/worker.js    # second terminal, same env
   ```

5. **Admin.** `pnpm --filter @amar-elaka/admin dev` → <http://localhost:3002>.
6. **Moderator login for the admin.** Seed users have phones only. Give the Mirpur moderator (+8801700000003) an email
   login once:

   ```sh
   curl -s -X POST localhost:3000/api/v1/auth/otp/request -H 'content-type: application/json' \
        -d '{"phone":"+8801700000003"}'
   # the API console prints: [LocalSmsProvider] to +8801700000003: … <code>
   curl -s -X POST localhost:3000/api/v1/auth/otp/verify -H 'content-type: application/json' \
        -d '{"phone":"+8801700000003","code":"<code>","device":{"platformCode":"web"}}'   # → accessToken
   curl -s -X POST localhost:3000/api/v1/auth/email/register -H "authorization: Bearer <accessToken>" \
        -H 'content-type: application/json' -d '{"email":"mod@example.com","password":"<a password>"}'
   ```

### Steps (record ✅/❌ and a screenshot for each)

| #   | Do                                                                                                                                                                                                                                                                                                                                                                                                   | Expect                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Install.** USB: `flutter run --dart-define=API_BASE_URL=http://<PC-IP>:3000/api/v1`, or the VS Code launch "Phone (WiFi)".                                                                                                                                                                                                                                                                         | The app opens in Bengali (splash, then the location question).                                                                                                                                                                  |
| 2   | **Pick the area.** Allow location. On "এই এলাকাটি কি আপনার?" tap "হ্যাঁ, এটাই ঠিক আছে"; if you aren't near Mirpur, tap "অন্য এলাকা বেছে নিন" and choose মিরপুর.                                                                                                                                                                                                                                      | The app bar shows "মিরপুর"; the Home tab opens.                                                                                                                                                                                 |
| 3   | **Browse the feed.** Scroll Home; switch "আমার এলাকা" / "আশেপাশে" / "সারা দেশ".                                                                                                                                                                                                                                                                                                                      | Cards with photo, price, area and "… কিমি দূরে"; more load as you scroll; the bazar prices and emergency numbers cards appear.                                                                                                  |
| 4   | **Filter.** Tap the "টু-লেট / বাসা ভাড়া" chip, then "ফিল্টার", set শোবার ঘর ≥ 2, tap "ফলাফল দেখুন".                                                                                                                                                                                                                                                                                                 | The button reads "ফিল্টার (1)"; every card is a to-let with 2+ bedrooms. "সব মুছুন" brings everything back.                                                                                                                     |
| 5   | **Search in Banglish.** Tap the search bar ("খুঁজুন: ডাক্তার, basa vara, mobile…"), type `basa vara`.                                                                                                                                                                                                                                                                                                | Suggestions list the to-let category; results are to-let listings even though no listing says "basa vara". Try `daktar` too: same as ডাক্তার.                                                                                   |
| 6   | **Open the detail.** Tap a result.                                                                                                                                                                                                                                                                                                                                                                   | Gallery (swipe, pinch), details, seller with "ফোন যাচাই করা", similar posts.                                                                                                                                                    |
| 7   | **Call.** Tap "কল".                                                                                                                                                                                                                                                                                                                                                                                  | The phone's dialer opens with the post's contact number (seed posts use +88017000000xx / +88017200000xx). Back in the app, pull to refresh: "বার যোগাযোগ" went up by one (the lead).                                            |
| 8   | **Save.** Tap "সেভ". As a guest you are sent to sign in: use 01700000005, read the code from the API console (`[LocalSmsProvider] …`), and save again.                                                                                                                                                                                                                                               | The button becomes "সেভ করা". Profile → "সেভ করা" lists it.                                                                                                                                                                     |
| 9   | **Post a listing with photos.** To see moderation, use a **new number** (e.g. 01711000001): trust starts at 20, below the auto-approve threshold of 60, so the post waits for review. Then: Post tab → "নতুন পোস্ট করুন" → বিভাগ (e.g. কেনা-বেচা) → বিস্তারিত (title, price) → ছবি (2–3 photos, camera or gallery; wait for the ticks) → অবস্থান (move the pin) → যোগাযোগ → দেখে নিন → "পোস্ট করুন". | "পোস্টটি রিভিউতে আছে"; "আমার পোস্ট" shows it under "রিভিউতে". Kill the app mid-upload once: the draft and photos come back.                                                                                                     |
| 10  | **See it in moderation.** Admin → log in as mod@example.com → মডারেশন → পোস্ট.                                                                                                                                                                                                                                                                                                                       | Your post is in the queue, reason "নতুন/কম ট্রাস্ট", with its photo count.                                                                                                                                                      |
| 11  | **Approve.** Tap "অনুমোদন".                                                                                                                                                                                                                                                                                                                                                                          | Toast "পোস্ট অনুমোদিত হয়েছে". On the phone: the bell shows 1 → "আপনার বিজ্ঞাপন প্রকাশিত হয়েছে"; "আমার পোস্ট" moves it to "লাইভ".                                                                                              |
| 12  | **Live on the map.** Map tab; move to where you put the pin (zoom ≥ 16); tap "এই এলাকায় খুঁজুন" if shown. "তালিকা" lists what is on the map.                                                                                                                                                                                                                                                        | A listing pin at the spot; tapping it opens the preview with photo, price and "কল".                                                                                                                                             |
| 13  | **Mark it sold.** Post tab → "আমার পোস্ট" → লাইভ → your post → "বিক্রি হয়েছে".                                                                                                                                                                                                                                                                                                                      | It moves to the "বিক্রি হয়েছে" tab. Detail says "বিক্রি হয়ে গেছে". Within 60 s (`map_features_cache_seconds`) the pin leaves the map, and it leaves search. A buyer who saved it sees "বিক্রি হয়ে গেছে" in their saved list. |

**Known on a real phone:**

- Not yet verified on a device: MapLibre reading `pmtiles://file://` and `file://` glyphs for the offline area.
- Google sign-in needs client IDs; use phone OTP. Without them the button now says it failed instead of doing nothing.
- Release signing is set up and verified (`apps/mobile/README.md`, "Release builds").

### Walked on a device (2026-10-08)

- **Setup:** an Android 9 emulator (BlueStacks, x86_64, 720×1280, phone language English).
- **App:** a profile build against a local API: seeded `ae_device` DB, the API and worker, `adb reverse tcp:3000`,
  `SMS_PROVIDER=local` (codes read from the API log).
- **Not on this setup:** no base-map tiles, so the map showed its "unavailable" notice; steps 10–11 ran through
  the moderation API as the seeded moderator, not the admin UI.

**Steps 1–13 all pass after the fixes below:** location → "is this your area?" → Bengali home; feed, Banglish search
(`basa vara` → to-let results); detail → call → dialer; save (guest → sign-in → back); a post with a photo → queue →
approved (`moderation_actions` row) → "প্রকাশিত হয়েছে" notification → live → sold at 24,000 (moved to "বিক্রি হয়েছে").

**Bugs the device found, all fixed with tests** (none could show in the suites, which fake the HTTP client, the clock,
the router extras or the location service):

| Bug                                                                             | Cause                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Phone login failed for everyone (VALIDATION_FAILED)                             | The app sent unknown device fields as `null`; the API took a string or nothing                           |
| Save, follow, mark-read all failed (400)                                        | Dio sends `content-type: application/json` with no body; Fastify refuses that before any guard           |
| Every session ended after 15 minutes                                            | The token refresh went without `X-Tenant-Id` (TENANT_REQUIRED), and the replay sent the old token        |
| The app was in English                                                          | It followed the phone's language; most phones here are English. Bengali now, English opt-in in Profile   |
| Finding the area spun for ever; the map list stayed empty                       | `getCurrentPosition()` had no time limit; now 15 s, then the last known position                         |
| A crash the first time location found an area                                   | The confirm route read `state.extra!`; a redirect carries no extra                                       |
| A crash after "not now"; "save" stayed on the profile page                      | Popping into the code page; a router refresh undid the pops. `leaveAuthFlow()` after the refresh settles |
| A burst of verify requests used up the code's attempts                          | Each refill of the boxes submitted again; one at a time now                                              |
| New users were offered "0077" as their name                                     | The phone-digits placeholder was prefilled as a real name                                                |
| "Used ৬ months" in a seller's description; "33 সেকেন্ড" in the resend countdown | Free text had its digits rewritten; a count in a Bengali sentence wasn't                                 |
| Google sign-in did nothing                                                      | A failure was returned as "cancelled"                                                                    |

---

## 11. `docs/specs/schema.md` vs migrations

- **Tables:** _fixed_. 10 Month 2 tables had no section (`member_trust_scores`, `moderation_queue_items`,
  `scheduled_jobs`, `job_runs`, `post_short_links`, `saved_places`, `saved_stores`, `geo_provider_endpoints`,
  `geo_provider_statuses`, `geo_provider_calls`). They are now in §13A with scope, columns and RLS.
- **Migration notes:** 0042–0048 each have one.
- **Not reconciled:** the Month 2 SQL functions (about 40 new) are documented in their migrations' headers and ADRs, not
  in `schema.md` §11.

---

## 12. Top 5 risks for Month 3

1. **Payments and credits arrive on code that has never seen real users.**
   - Month 3 brings money (credits, boosts, subscriptions), where rule 2 (transactions + row locks) and auditability
     matter most.
   - There is still no deployment, no pilot and no production SMS. Phone login fails outside dev, so no real user has
     exercised anything.
   - Pick the SMS gateway (sender ID registration has lead time), set the Android release config, and run a closed pilot
     **before** money code is merged.
2. **The same rule keeps drifting.**
   - This review found four drifts (§6): map vs feed expiry, heatmap vs unmet-demand ownership, offline vs ownership
     area, and client vs server limits.
   - Payments will add more ("is this credit spendable", "is this boost live").
   - Consolidate visibility into `post_is_listed()` and field filters into one SQL path, and give each money rule exactly
     one SQL function with a test that runs every caller.
3. **Cost grows with density.**
   - The map's `open_now`, feed "nearby" scoring every post in the radius, trending's group-by over all queries: each is
     fine at a 30k-post pilot thana and linear beyond it.
   - Boosts in Month 3 add ranking work to the same feed.
   - Set budgets (p95 per endpoint) and keep this review's perf setup (`docs/status`, seed + volume script) as a CI job,
     so a regression shows before users feel it.
4. **Geo spend has no real baseline.**
   - The Barikoi plan's quota isn't recorded, `barikoi_daily_call_budget` is a guess, and §7's numbers are projections.
   - The `map_style_fallback` path would bypass the budget entirely.
   - Record the plan limit, collect two weeks of pilot `geo_provider_calls`, and remove or proxy the fallback.
5. **The test suite is slow and order-sensitive.**
   - A full run is about 25 minutes serially on this laptop; one leaked fixture (200k outbox rows) made a different
     suite time out; Flutter socket tests depended on the environment.
   - As Month 3 adds money flows, flaky tests will be ignored, which is how money bugs ship.
   - Make every suite clean up what it creates (an afterAll check that the outbox and fixture prefixes are empty), keep
     suites isolated in CI jobs, and treat any flake as a bug (as here).

**Smaller things:**

- `search_suggest_limit` is unused.
- The app has no store screen (places have one since 0049).
- `PERMISSIONS_CACHE_TTL_MS` (5 min) is still unreviewed.

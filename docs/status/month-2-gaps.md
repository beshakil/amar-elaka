# Month 2 gaps: what Month 3 starts on

Audited 2026-10-08 against `main` at `772cfe2`. **No code was changed for this audit.** It builds on
[month-2-review.md](month-2-review.md) (2026-10-07), checks that review's "fixed" claims against today's code, and
does not repeat items that really are closed. Sections 4 (phone numbers) and 7 (single-server assumptions) are new;
the review never looked at either.

## TL;DR

- **We cannot deploy in week 13 with what is in the repo.**
  - The production image has no way to run migrations.
  - `apps/web` and `apps/admin` have no Dockerfile.
  - CI has never built the API image.
  - The SMS account doesn't exist yet, so nobody can log in.
  - No pipeline builds the base map.
- **The phone-number rule is broken today, in five places** (§4). The worst two:
  - a category field of type `phone` (`serial_phone` on doctor chambers) goes out in plain text in the public post
    detail and in the SSR HTML;
  - a store's number goes out on the public map preview even though the store page promises never to show it.
- **Trust has three readers, and two of them ignore staleness** (§3). A ban marks a member's score stale, but the feed
  and the "trusted" seller badge keep using the old score until something happens to read it through TypeScript.
  Month 3 ships bans.
- **The map's "open now" still costs 1.7–2.6 s per request at thana scale** (§6). It calls `is_open_at()` once per
  place on screen. The set-based fix the review asked for was never built; 0049 added indexes instead.
- **The OTP code length is a setting on the server and a constant (6) in the app** (§5). Change the setting and
  nobody can log in from the app.
- The "nothing skipped, no TODOs" picture is true but misleading. The web e2e suite runs only against a stub API,
  there is no crash reporting, and yesterday's device walkthrough found 11 bugs that no suite could see.

---

## 1. Month 2 plan: missing, partial or stubbed

The plan: weeks 5–9 in the old CLAUDE.md "Current Phase" (posts, feed, search UX, map) plus the week 9 list (place
marking, claims, duplicates, open-now, offline area, heatmap, map moderation). The review called every item ✅. That
is true for the API. It isn't true for the clients.

| Item                                    | State          | What is actually missing                                                                                                                                                                                                    |
| --------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store follows (week 6, ADR 037)         | **API only**   | No client can follow a store. The app has no store screen at all. The web store page (`app/store/[slug]/page.tsx:120`) shows a follower count but has no button. The follow API and the store-activity metric serve nobody. |
| Saved items (week 6)                    | **Partial**    | The web can save a post (since 890c3c1) but has no page that lists saved items: `app/me/` has only `posts`. Saved stores open nothing in the app, because there is no store screen.                                         |
| Search UX (week 7)                      | **Stub shown** | The voice-search button in the app's search field shows "coming soon" (`search_field.dart:70-72`). Either build it or remove it before a public release.                                                                    |
| Map screens, offline area (weeks 8–9)   | **Unverified** | Not seen on a device: the base map itself (the device walkthrough ran with no tiles and showed "map unavailable") and MapLibre reading `pmtiles://file://` offline. Unit tests only.                                        |
| Phone login in production (Month 1 → 2) | **Blocked**    | The BulkSMSBD provider is coded (ADR 053). The account, sender ID and IP whitelist don't exist. In production the API refuses to start on the logging provider, so this blocks launch outright.                             |
| Geo cost baseline (week 8)              | **Projection** | No real `geo_provider_calls` data, and the Barikoi plan quota is still not recorded in ADR 044.                                                                                                                             |
| Feed "nearby" at scale                  | **Deferred**   | The candidate cap was deliberately not built. `feed_posts` scores every eligible post in the radius, so its cost is linear in density (§6).                                                                                 |
| `schema.md` §11 functions               | **Stale**      | About 40 Month 2 SQL functions are documented only in migration headers.                                                                                                                                                    |
| `search:reindex` CLI                    | **Bug (new)**  | It rebuilt all three indexes in about 60 s (log at 20:49:18), then never exited; it was still hanging 10+ minutes later and was killed by hand. Any deploy step or cron that runs it will hang.                             |
| Info tab                                | Placeholder    | `info_screen.dart` shows "তথ্য শীঘ্রই আসছে". This is Month 3 scope (local information services), so expected, but it is the fourth tab of a production app.                                                                 |

## 2. TODO / FIXME / skipped tests added in Month 2

- **TODO / FIXME / HACK in code: zero.** The Month 1 Android TODOs are gone (`build.gradle.kts` has a real
  `applicationId` and release signing). The only hits are in vendored Lighthouse HTML under `docs/perf/lighthouse/`.
- **Skipped tests: zero.** No `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `skipIf`, Flutter `skip:`, or early
  `return` on a missing env var.
- **`UnimplementedError`:** only in test fakes (`place_feedback_test.dart`).

None of that means everything is tested. The real "skips" are structural:

- **Playwright runs only against the stub API** (`ci.yml:292`, "Browser e2e (production builds, stub API)"). No test
  drives the real web app against the real API. The stub's types had already drifted once (fixed 2026-10-07).
- **Device-only behaviour has no automated coverage.** The 2026-10-08 walkthrough found 11 bugs (login broken for
  everyone, every save failing with 400, sessions dying after 15 minutes, crashes). None of them could fail a suite,
  because the suites fake the HTTP client, the clock, the router and location.
- **238 `settings-exempt` markers** (226 yesterday). Each one is an opt-out from rule 9 (§5).

## 3. Logic implemented in more than one place

| Rule                          | Verdict                    | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trust score**               | ❌ **3 readers, 2 drift**  | The formula lives once, in `apps/api/src/trust/trust-formula.ts`. The _effective score_ (`coalesce(override_score, score)`, recomputed when stale) is read in three places: (1) `trust/trust-score.service.ts:42-49` recomputes when `next_recompute_at <= now()`; (2) `feed_posts` in `infra/migrations/0049_open_now_indexes_and_client_settings.sql:441-444` and (3) `post_seller_card` in the same file, `:888`, both read the stored row and **ignore staleness**. |
| Tenant area geometry          | ⚠️ 3 copies                | Canonical: `tenant_area_distance_m()` (0049), used by `nearest_tenants`, `tenant_distance_m` and `tenant_covers_point`. Copies: `apps/api/src/map/offline/offline-map.repository.ts:61-79` (offline cut: falls back to `boundary_simplified` and the bare centre; ignores tenant status) and `apps/api/src/tenants/tenants.service.ts:276-296` (`boundaryRadiusKm`, map zoom only, prefers `boundary_simplified`).                                                      |
| Phone masking                 | ⚠️ policy in one flow only | `maskPhone()` (`places/place-view.ts:97-105`) masks a place's number in the claim flow "so it can't be harvested". The same number is returned unmasked by `GET /places/:id` (§4).                                                                                                                                                                                                                                                                                      |
| OTP code length               | ❌ 2 sources               | `otp_code_length` setting (`auth/otp/otp.service.ts:92`) vs `_codeLength = 6` in `apps/mobile/lib/features/auth/presentation/otp_verify_screen.dart:17`.                                                                                                                                                                                                                                                                                                                |
| Saved-search minimum radius   | ⚠️ 2 copies                | `MIN_RADIUS_KM = 0.5` in `saved-searches/dto/saved-searches.dto.ts:16` and the DB check `saved_searches_radius_km_ck` (0009). Neither reads a setting.                                                                                                                                                                                                                                                                                                                  |
| Visibility                    | ✅                         | `post_is_listed()` / `post_is_viewable()` (0049) everywhere, enforced by `single-visibility-rule.spec.ts`. The remaining `'live'` literals are state-machine transitions, the expiry sweep and trust inputs, not visibility.                                                                                                                                                                                                                                            |
| Open-now                      | ✅                         | `is_open_at()` only. The clients only display the API's `openState`; none of them computes it.                                                                                                                                                                                                                                                                                                                                                                          |
| Field filters                 | ✅                         | One SQL matcher (`post_field_filter_matches`) plus the Meilisearch filter builder, held together by `field-filter-parity.db-spec.ts`.                                                                                                                                                                                                                                                                                                                                   |
| Tenant assignment (ownership) | ✅                         | `resolve_owning_tenant()` through `PostOwnershipService.resolve`.                                                                                                                                                                                                                                                                                                                                                                                                       |

**Why the trust drift matters now:** `TrustScoreService.markStale()` is how "a ban was issued" reaches the score (its
own doc comment says so). A banned or demoted seller keeps their old feed weight and their "trusted" badge until some
TypeScript path happens to read their score. Month 3 builds "trust and bans" on top of this. To get to one: a SQL
`member_effective_trust(tenant, member)` that both SQL readers call, plus recomputing synchronously on ban instead of
marking stale.

## 4. Where a phone number can leak outside the contact endpoint

The rule: phone numbers come back only from `POST /posts/:id/contact`, which writes a `lead_event`; never in detail
responses, HTML, chat payloads or exports. Checked: every API response DTO and repository that selects a phone
column, the web SSR pages and JSON-LD, admin tables and CSV export, mobile logging, pino config, the audit-log
interceptor, the exception filter, SMS providers and search documents.

| #   | Severity   | Leak                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                                                                                                                                                              |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **High**   | **Category fields of type `phone` are public.** The seeded doctor-chamber category has `serial_phone`. `GET /posts/:id/detail` is anonymous and writes no lead; it returns every rendered field with its raw value. The web renders the number as text into the server-rendered listing page (so crawlers index it), and into cards when the field is a card field. The publish check keeps `phone` fields out of filters and analytics, but not out of display. | `apps/api/src/engagement/post-detail.service.ts:171-185`; `apps/web/src/lib/posts/detail-display.ts:28-29`; `apps/web/src/lib/posts/display.ts:38-39`; seed `database/seed/data/categories.ts:414` |
| 2   | **High**   | **A store's phone and WhatsApp are public through the map preview.** `GET /map/features/stores/:id` (anonymous) returns `phone_e164` and `whatsapp_e164`. The web panel turns `phones[0]` into a `tel:` link; the app's preview sheet has "call". No lead is recorded. This contradicts `GET /stores/:slug`, whose DTO says "Never its phone number".                                                                                                            | `apps/api/src/map/map-preview.repository.ts:54-66`; `apps/web/src/components/map/map-preview-panel.tsx:131-194`; contradicts `apps/api/src/seo/dto/seo.dto.ts:80`                                  |
| 3   | **High**   | **Place phones are public in full** through `GET /places/:id` (optional auth) and the map preview. Any member can add a place with any number (`places.service.ts:91`); above `place_contribution_trust_threshold` it is published without review. Small shops here list the owner's personal mobile. The claim flow masks exactly these numbers "so they can't be harvested" (`maskPhone`), so the code already disagrees with itself.                          | `apps/api/src/places/place-view.ts:48`; `apps/api/src/map/map-preview.repository.ts:97-107`                                                                                                        |
| 4   | **Medium** | **Audit logs keep raw staff request bodies.** `AuditLogInterceptor` stores `request.body` as `changes` for every permission-gated write by staff: place edits with `phones`, staff post edits with `contactPhone`, and so on. Nothing redacts them, and no scrub or anonymize path touches `audit_logs`. The numbers outlive a post's privacy scrub.                                                                                                             | `apps/api/src/rbac/audit-log.interceptor.ts:60-71`                                                                                                                                                 |
| 5   | **Medium** | **Admin CSV export includes the claimant's OTP-verified phone.** The place-claims table has an `otp` column and `exportFilename="place-claims"`; the generic export writes every visible data column.                                                                                                                                                                                                                                                            | `apps/admin/src/app/(dashboard)/moderation/places/places-client.tsx:308,321`; `apps/admin/src/components/data-table/data-table.tsx:165-178`                                                        |
| 6   | Medium     | **Numbers typed into free text go live once approved.** The pre-filter scans only `title` and `description`, so a number in a `text`/`textarea` custom field passes. A post flagged `contact_info` that a moderator approves goes live with the number in it.                                                                                                                                                                                                    | `apps/api/src/moderation/prefilter.ts:68-73`                                                                                                                                                       |
| 7   | Low        | `GET /posts/:id` returns `contact_phone_e164` to staff (owners seeing their own number is fine). It is a read outside the contact endpoint, with no lead and no audit row.                                                                                                                                                                                                                                                                                       | `apps/api/src/posts/posts.service.ts:821-824`                                                                                                                                                      |
| 8   | Low        | **Trending can surface a searched number.** `search_popular_queries` returns raw `q_normalized`. A number that `search_trending_min_searchers` distinct people search, and that finds results (because it sits in descriptions), becomes a public suggestion.                                                                                                                                                                                                    | `infra/migrations/0034_search_api.sql:212-232`                                                                                                                                                     |

**Not leaks** (checked):

- The tenant's support number and emergency contacts in `/tenant/config`, `/info` and JSON-LD are public service
  numbers, which is intended.
- `/me` returns the caller's own phone.
- pino logs no request bodies and redacts `authorization` and `cookie`. The exception filter logs only the URL.
- `BulkSmsBdProvider` never logs the number.
- `LocalSmsProvider` logs number and OTP, but production refuses to start with it.
- Search documents contain no phone fields.
- Notification payloads carry no phone.
- No chat exists yet.

**Decision needed before chat ships:** are business numbers (places, stores) covered by the rule? If yes, rows 2–3
must go through a contact endpoint that writes a lead (one for places and stores). If no, write the exception into
CLAUDE.md and drop the masking pretence. Either way, rows 1, 4 and 5 are bugs.

## 5. Numeric literals that belong in settings

`no-hardcoded-numbers.spec.ts` passes, but it only scans TypeScript in `apps/api/src`. **No guard covers Dart or the
web/admin apps.**

| Where                                                                                                                                                        | Value                                        | Why it's a setting                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/lib/features/auth/presentation/otp_verify_screen.dart:17`                                                                                       | `_codeLength = 6`                            | **Breaks login** if `otp_code_length` changes. Belongs in `/tenant/config`.                                                   |
| `apps/api/src/saved-searches/dto/saved-searches.dto.ts:16` + check in 0009                                                                                   | `MIN_RADIUS_KM = 0.5`                        | A product limit, marked "exempt" because it mirrors a DB constraint. The constraint is the problem.                           |
| `apps/api/src/saved-searches/saved-searches.schedule.ts:16-18`                                                                                               | `*/5` match, nightly pause, hourly unmet     | "Instant" alerts arrive up to 5 min + grace late. That is a product promise, filed under "ops tuning".                        |
| `apps/api/src/posts/posts-schedule.ts:15-19`                                                                                                                 | expiry `*/15`, reminders hourly, views 1 min | Reads now check `expires_at`, so expiry lag no longer shows. Reminder timing and view-count lag still do.                     |
| `apps/api/src/map/offline/offline-map.processor.ts:17`                                                                                                       | offline build hourly                         | How stale a downloaded area can be.                                                                                           |
| `apps/api/src/places/place-moderation.service.ts:581`                                                                                                        | `SAME_POINT_DEGREES = 0.00001` (~1 m)        | Decides whether a suggested location counts as a change.                                                                      |
| `apps/api/src/places/place-view.ts:97-100`                                                                                                                   | mask keeps 5 + 3 digits                      | A privacy policy, not a tuning constant.                                                                                      |
| `apps/api/src/locations/geocoding/geo-budget-alerts.ts:12`                                                                                                   | budget-alert flag TTL 2 days                 | How often admins hear that the Barikoi budget is exhausted.                                                                   |
| `apps/web/src/lib/seo/public-gate.ts:24`, `apps/web/src/middleware.ts:25`                                                                                    | 60 s                                         | How long a removed post or terminated tenant still renders on each web replica (§7).                                          |
| `apps/web/src/lib/tenant.ts:12`                                                                                                                              | `TENANT_CACHE_SECONDS = 300`                 | Tenant config (limits, flags) reaches the web up to 5 min late.                                                               |
| `apps/mobile/lib/features/media_upload/data/media_upload_transport.dart:118-119`                                                                             | 40 × 500 ms                                  | After 20 s of worker backlog the app gives up on a photo. In production the worker is shared with every other job.            |
| Client fallbacks: `image_compressor.dart:12-13` (1200 px / 80), `upload_queue.dart:43` (10), web `compress-image.ts:11` (0.8), web `upload-queue.ts:30` (10) | used when config lacks `media`               | The fallbacks silently disagree with the server whenever the setting moves and config is missing or old. Fail closed instead. |

Infrastructure constants (lat/lng bounds, byte signatures, retry counts, cache keys, unit conversions) were checked
and are fine as constants.

## 6. The 10 slowest queries (pg_stat_statements + EXPLAIN ANALYZE)

### Method (re-measured today, after 0049)

Yesterday's top-10 predates 0049, which rewrote `feed_posts`, `map_features` and visibility, so it was measured again.

- **Database:** a separate Postgres 16 cluster (port 5435) with `pg_stat_statements` (`track = all`) and
  `auto_explain`. It holds a copy of the fully migrated test DB (0000–0049), seeded, then scaled like last time:
  **30,030 posts (25,650 live, 16,500 not yet expired), 3,020 places, 11,910 opening-hours rows, 50,460 search
  queries.** Meilisearch was reindexed on a separate prefix.
- **Workload:** the real API (`node dist/main.js`, on :3010 as `ae_app`) driven over HTTP for 60 rounds from random
  viewer positions around Mirpur. Each round: feed (nearby, area, category, open now), search (posts, places),
  suggest, trending, map at z12/14/16 and z15 + open now, post detail, place detail, both previews, distance,
  tenants nearby, tenant config, store page, posts sitemap, moderation queues, places review queue, duplicates,
  notifications and saved. A further 40 rounds of both heatmaps and unmet demand ran as the tenant admin. Redis was
  flushed every round, so caches were always cold: the **worst case, not the typical case**.
- **Plans:** `auto_explain` (`log_analyze`, `log_buffers`, `log_nested_statements`, ≥ 20 ms) captured 5 more rounds:
  EXPLAIN ANALYZE of the real calls with their real parameters, including the statements inside functions.
- **Scale:** this laptop is about 3–4× slower than a server. Divide by 3 for a rough production figure.

### The 10 slowest statements (by mean, `ae_app`, ≥ 2 calls)

| #   | Statement (caller)                                                                          | Calls | Mean       | Max      | What EXPLAIN ANALYZE shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------- | ----- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `map_features(...)` (`GET /map/features`)                                                   | 240   | **499 ms** | 4,438 ms | Two separate problems. **With `open_now` (z15, 0.06° box): 1.7–2.6 s.** 1,375 candidates × one `is_open_at()` each (`Result … loops=1375`, 1.8 ms each), which is 2.5 s of a 2.6 s call. **Without `open_now`: 141–388 ms at every zoom.** The posts in the box come through a BitmapOr on `posts_expires_at_idx` (16,470 rows; the shape `post_is_listed` inlines to), 10,294 survive the box filter, and then the per-point kind-rule lookup (`jsonb_array_elements(kind_rules)` + sort) runs **11,875 times**: about 100 ms of a 205 ms z14 call. The planner estimates `rows=5` against 11,875 actual. |
| 2   | Posts sitemap (`seo/seo.repository.ts:138`, `GET /seo/sitemap/posts`)                       | 60    | 69 ms      | 228 ms   | Parallel bitmap scan of every listed post, a full sort by id, then `OFFSET $2 LIMIT 10000`. With OFFSET paging every later page re-sorts everything before it, so cost grows with page number and with the thana. Keyset paging (`id > $last`) fixes it.                                                                                                                                                                                                                                                                                                                                                   |
| 3   | `feed_posts(...)`, shape A (nearby / category / open now; also post detail's similar posts) | 180   | 51 ms      | 160 ms   | `posts_live_category_location_gist_idx` (5,830 index rows), then **all 3,323 eligible posts are scored** before the top 20 (`CTE Scan on eligible … rows=3323`). The planner still estimates `rows=1`. That is yesterday's §9 #2, unchanged: cost is linear in posts within the radius.                                                                                                                                                                                                                                                                                                                    |
| 4   | `open_states('place', [20 ids])` (search `type=places`)                                     | 60    | 47 ms      | 147 ms   | `open_states` is `SELECT is_open_at(...) FROM unnest(ids)`: no set-based work, ~2.3 ms per id. Forced over 500 ids it took **3.9 s** against ~1–2 s calling `is_open_at` row by row. Each `is_open_at` runs 8 nested statements, re-reading the tenant timezone and three settings (`hours_lookahead_days`, `hours_opens_soon_minutes`, `hours_closes_soon_minutes`) for every id.                                                                                                                                                                                                                         |
| 5   | `feed_posts(...)`, shape B (area scope)                                                     | 120   | 33 ms      | 85 ms    | Same plan as #3 with fewer posts in the area polygon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | `heatmap_cells(...)` (`GET /analytics/heatmap`)                                             | 80    | 27 ms      | 59 ms    | Not re-captured (the function checks the tenant-admin role inside, and it stayed under the 20 ms capture threshold). Yesterday's plan: a seq scan on `search_queries` for demand, which is right at 2 tenants.                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | `search_popular_queries(...)` (trending, suggestions)                                       | 120   | 21 ms      | 102 ms   | `search_queries_tenant_created_idx` (5,830 rows) → sort → GroupAggregate over 4,880 rows for the 7-day window. Linear in searches; fine now, and it runs on every suggest call.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | `open_states('place', [1 id])` (place detail)                                               | 60    | 3.2 ms     | 16 ms    | One `is_open_at`, PK lookups only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | `my_saved_items(...)` (`GET /saved`)                                                        | 60    | 2.8 ms     | 6 ms     | PK/FK lookups; fine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | `post_seller_card(...)` (post detail)                                                       | 60    | 2.2 ms     | 11 ms    | PK/FK lookups; fine. This is also trust reader #3 in §3: it ignores staleness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

HTTP latency for the same run (cold cache):

| Endpoint           | Mean       | Max      |
| ------------------ | ---------- | -------- |
| map, z15, open now | 1,570 ms   | 4,487 ms |
| map, z12–z16       | 137–197 ms |          |
| posts sitemap      | 134 ms     |          |
| post detail        | 124 ms     |          |
| feed               | 78–98 ms   |          |
| search             | 84 ms      |          |

**Blunt read:**

- **The map's `open_now` is still a per-row function call.** Yesterday's "What to do next" asked for a set-based
  open-now. 0049 added indexes instead. On a server this is still ~0.5–0.8 s per request, and it scales with the
  number of places on screen.
- **0049's "715 ms" was a smaller box.** At a box that covers most of the thana it is 1.7–2.6 s here.
- **`map_features` without `open_now` is 141–388 ms here, against 32–96 ms in yesterday's run.** The datasets differ
  (both synthetic), so this isn't a proven regression. But the plan now reaches posts through the `expires_at` btree,
  not the location GiST, and spends half its time on per-point kind rules. Re-check it against yesterday's dump before
  the map ships to production.
- **Fixes:**
  - one set-based `open_states` (a single query over `place_hours` + exceptions for all ids, with settings and
    timezone read once), used by `map_features` too;
  - resolve kind rules once per request, not once per point;
  - set `ROWS` on `feed_posts` and `map_features`;
  - keyset paging for sitemaps.

## 7. Single-server assumptions that break in production (week 13)

**What is already safe:**

- Every cache that matters is in Redis: permissions, tenant lookup, map features, OTP, upload and geo rate limits,
  and the Barikoi budget (`INCRBY`, with a DB fallback).
- Settings caches are per-process but invalidated over Redis pub/sub (`redis-settings-invalidation.bus.ts`).
- Every repeatable job is a BullMQ job scheduler registered only in `WorkerModule`. Nothing uses `@Cron`,
  `setInterval` or an in-process scheduler.
- Per-process caches in the API are either keyed by an immutable version (field validators, offline checksums by
  mtime + size) or tiny.

**What breaks:**

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                                                                  | Blocks week 13?     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| 1   | **The production image cannot migrate.** It copies `dist`, `assets` and `node_modules`, but not `infra/migrations` or the drizzle config. `db:migrate` is `drizzle-kit migrate`, a dev CLI. There is no migrate entrypoint or release command. The only programmatic migrator is the test helper and `seed/reset.ts`, which walks up to the repo root.                                                                                                                                                                                                                 | `apps/api/Dockerfile`; `apps/api/package.json:24`                                                      | **Yes**             |
| 2   | **No Dockerfile for `apps/web` or `apps/admin`**, and CI builds no image at all. The API Dockerfile has never been built by CI, so nobody knows whether it still builds.                                                                                                                                                                                                                                                                                                                                                                                               | repo root, `.github/workflows/ci.yml`                                                                  | **Yes**             |
| 3   | **API and worker must share one disk, which pins them to one host.** Uploads: the API writes originals and the worker writes variants (ADR 028 documents this). Tiles: the worker's offline-map builder writes `.pmtiles` into `MAP_TILES_PATH` and the API serves them from there; ADR 028 doesn't mention this. `MAP_TILES_PATH` defaults to the relative `./storage/map`, which lands inside `/app/storage` only because the image's cwd is `/app`. Set it explicitly. The volume is the only copy of every photo, and no backup has been set up or restore-tested. | `apps/api/src/config/env.schema.ts:70,108`; `map/offline/offline-map.builder.ts:80-131`; ADR 028       | Configure it        |
| 4   | **The national base map is a manual step.** `scripts/map/build-tiles.sh` has to be run by hand and its output copied onto the volume. Without it the map says "unavailable" (that is how the device walkthrough ran).                                                                                                                                                                                                                                                                                                                                                  | `scripts/map/`                                                                                         | **Yes** for the map |
| 5   | **The API process also runs a queue worker.** `MailModule` provides `MailProcessor` and is imported by `AppModule` (on purpose, so `pnpm dev` sends mail). In production every API replica consumes the mail queue and renders MJML in the request process.                                                                                                                                                                                                                                                                                                            | `apps/api/src/mail/mail.module.ts:13`; `apps/api/src/worker.module.ts:23-24`                           | No                  |
| 6   | **The web keeps state per process.** Tenant resolution (60 s) and the listing-status gate (60 s) live in module-level `Map`s, so each replica serves a takedown or a terminated tenant on its own clock. The Next data cache is on container disk: every deploy starts cold, and nothing revalidates on demand (no `revalidateTag`), so content changes wait for `web_*_revalidate_seconds` (up to 600 s).                                                                                                                                                             | `apps/web/src/middleware.ts:31`; `apps/web/src/lib/seo/public-gate.ts:36`; `apps/web/next.config.ts:9` | No                  |
| 7   | **`search:reindex` never exits** (§1). A deploy step that runs it hangs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/api/src/search/cli/reindex.ts`                                                                   | If used             |
| 8   | **No crash or error reporting.** The app sends `FlutterError` and uncaught errors to `debugPrint` in debug builds only; in release they go nowhere. The API logs to stdout only. The first production bugs will be invisible unless a user complains.                                                                                                                                                                                                                                                                                                                  | `apps/mobile/lib/main.dart:19-22`                                                                      | Should              |

## 8. Top 5 risks for Month 3

1. **The week-13 deploy slips, or goes out half-configured.**
   - Today: no migration path in the image, no web or admin images, no SMS account, no tiles pipeline, no backups, and
     no staging environment to rehearse on.
   - Any one of these is a day's work. Together, with chat and stores being built in the same weeks, they are the
     schedule.
   - Do it first: a staging deploy on Coolify by end of week 11 that runs migrations, serves photos and tiles, and
     logs in by real SMS.
2. **Chat lands on a phone rule that is already broken.**
   - §4 has three high-severity leaks, and chat is the classic place numbers get swapped.
   - Fix rows 1–5, decide the business-number policy, and give chat a number detector that shares the pre-filter's
     matcher (one implementation) before chat is merged.
3. **Bans won't bite.**
   - Two SQL readers ignore trust staleness (§3), so a banned member keeps their feed weight and badge.
   - The phone and email of a banned or deleted user also persist in `audit_logs` (§4.4).
   - There is no account-deletion path at all. Google Play requires in-app account deletion for any app that creates
     accounts, so this blocks the store listing.
   - One `member_effective_trust()`; recompute on ban, not just mark stale; an anonymize path that checks legal holds
     and covers `audit_logs`.
4. **Everything is on one box with one disk and nobody watching.**
   - API, worker, Postgres, Redis, Meilisearch, uploads and tiles share one VPS. Photos have exactly one copy.
   - There is no crash reporting, and the reindex hangs.
   - The first incident will be found by a user, and the first disk failure loses every photo. Set up backups and a
     tested restore, Sentry (or equivalent) on app and API, and an alert on queue depth before launch.
5. **The tests can't see what breaks in production.**
   - Web e2e runs against a stub. Yesterday a device found 11 bugs that ~2,200 green tests missed. No guard covers
     client-side literals (§5).
   - Month 3 adds chat (sockets), push notifications and a real deployment, which are exactly the things fakes hide.
   - Run Playwright against the real API in CI, add one device smoke test per release (the walkthrough in
     month-2-review §10, scripted), and extend the hardcoded-numbers guard to Dart and the web.

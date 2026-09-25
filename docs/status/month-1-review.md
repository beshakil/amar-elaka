# Month 1 review — repo audit before Month 2

Audited 2026-09-25 against the working tree (branch `main`, HEAD `95c59b7`). No code was changed.

## Follow-up (same day, branch `feat/week-4-foundation`)

**Done:**

- Week 4 work committed in six area commits.
- Email placeholders now interpolate (`{{ body }}` and `{{body}}` both work).
- `profile_display_name_max_length` is seeded (0022, default 60, bounds 10–200).
  `agent_visit_edit_window_hours` is registered. A new unit test fails whenever the registry and the seeded rows diverge.
- `POST /auth/otp/request` returns `resendAfterSeconds`, and the mobile resend timer uses it instead of 30 s.
- `resolve_owning_tenant()` and `discover_nearby()` added (0023), with `cross-tenant-discovery.db-spec.ts`.
- Search and suggest always filter by radius. Without a viewer location they centre on the tenant's map centre, and those
  hits have no distance.
- CI runs the API e2e suites (Postgres, Redis, Meilisearch, real object storage) and `pnpm format:check`.
- Web tenant resolution retries once.
- `schema.md` reconciled with 0013–0023.
- API unit tests: 485/485 pass.

**Found by the first real run of the DB and e2e suites** (local Postgres 16 + PostGIS, Redis, Meilisearch 1.8):

- **Login and token refresh never worked.** 0013's auth functions hit "column reference is ambiguous" (fixed in 0024).
- **Refresh-token theft detection never took effect.** The revocation was rolled back by its own RAISE (0024 + API).
- **Tenant resolution never reached the guard** (Fastify raw request). Every tenant route returned 400.
- **Google linking and email/password registration were silent no-ops** under RLS (0025).
- Unit/db/search suites exited on import in CI without a .env (placeholder env).
- Results after the fixes: DB 452/452, e2e 72/72 (all suites except media, which needs the Contabo CI bucket),
  search 38/38, unit 489/489.

**Still not run anywhere:** the media e2e suite (needs storage secrets) and mobile on a device. There is no Postgres/docker/Flutter in this environment. The 0023 SQL and plpgsql bodies were
checked with the real Postgres parser (libpg_query) only. The first CI run (or `test:db` locally) is the real check.

**Still open (needs a decision or later work):**

- Docker in WSL and `TEST_*` URLs in `.env`, so DB, e2e and search tests can run locally.
- The SMS gateway provider, Google OAuth client IDs, the Android application ID and release signing, and brand colours.
- `post_max_photos` and client image sizes from settings: do this with the post form. Today these numbers are only used by
  dev previews.
- `scrub_post`, `reveal_contact_phone`, `user_is_visible`, `neighbour_landmarks`: build these with posts and moderation.
- The degraded (Meilisearch-down) search fallback is still current-tenant only.

## TL;DR

The code that exists is careful and mostly well tested. But the foundation is less verified
than it looks, and one core Month 2 path is missing from the schema entirely.

**Blockers — fix before building posts/feed/map:**

1. **All of Week 4 is uncommitted.** HEAD is a single commit ("first commit", 2026-09-24). Migrations
   0017–0021, the `categories`, `media`, `search` and `locations` modules, `packages/dynamic-form`, and ~40
   test files are untracked (`??`). The old `storage/media-*` files are staged for deletion. CI has
   never seen any of it, and one disk failure loses a week of work.
2. **Cross-tenant discovery does not exist in the database.** The spec (§13.26) routes "near me" through
   `discover_nearby()` and post creation through `resolve_owning_tenant()`. **Neither function exists in
   any migration.** `posts_public_read` RLS only allows `tenant_id = current_tenant_id()`, so any
   Postgres-backed feed, map or post-detail read will be tenant-scoped, which breaks the new "radius, never
   tenant" rule. See §7 and Risk 1.
3. **Nothing that touches a database has been run here.** No Postgres, Redis or Meilisearch was reachable,
   docker is not installed in this WSL distro, and `.env` has none of the `TEST_*` URLs. `audit-schema.sql`,
   421 DB/Meili tests and 77 API e2e tests are **unverified**.
4. **Three production bugs found:** email templates never interpolate, profile update with a display name
   throws, and the mobile OTP resend button unlocks 30 s before the backend allows it (details in §3).

---

## 1. What exists and works

"Works" below means it **typechecks and passes unit tests**. Anything that needs Postgres, Redis, Meilisearch
or S3 could not be exercised here (see §4).

### apps/api (NestJS) — typecheck ✅, lint ✅, unit tests 478/481

| Module                                             | What's there                                                                                                                                                                       | State                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `auth`                                             | OTP request/verify, Google, email register/login, refresh, logout, logout-all, `GET/PATCH /auth/me` (10 endpoints). Argon2id, rotating refresh tokens, SECURITY DEFINER lookups.   | Works, except **PATCH /me with displayName throws** (§3) and **no real SMS gateway**. |
| `tenants`                                          | `tenant/config`, `tenants`, `tenants/nearby`, `tenants/resolve` (host → tenant), tenant lookup cache.                                                                              | Works.                                                                                |
| `rbac`                                             | Custom roles CRUD, member role assignment, `GET /me/permissions`, ownership guard, audit-log interceptor.                                                                          | Works. Tables `roles` / `role_permissions` are **not in the spec** (§7).              |
| `categories`                                       | Platform CRUD, schema draft → publish with versioning, tenant enable/order, public `categories` + `categories/schemas/:id`, field-filter compiler.                                 | Works (API only; **no admin UI**, see §2).                                            |
| `media`                                            | presign → PUT → confirm, image pipeline (variants + ThumbHash), magic-byte sniffing, per-hour/day rate limits, orphan sweep and purge (both check `legal_hold_blocks`).            | Works. Replaced `storage/media-uploads.*` (staged delete).                            |
| `storage`                                          | Local + S3 drivers behind a port; timeout/retry on the S3 client.                                                                                                                  | Works.                                                                                |
| `search`                                           | Meilisearch engine, outbox → relay → indexer, reindex CLI, Bengali text/transliteration, synonyms, Postgres ILIKE fallback with circuit breaker, `GET /search`, `/search/suggest`. | Works in unit tests. Meili/DB integration unverified.                                 |
| `locations`                                        | Geo area hierarchy, viewport, lookup, geocoding via Barikoi (forward/reverse/autocomplete, cached), HDX COD-AB importer, platform tenant-boundary `PUT`.                           | Works.                                                                                |
| `settings`                                         | Typed `SettingsService` over `platform_settings` + tenant overrides; 81 registry keys.                                                                                             | Works; **registry ↔ seed parity is not tested** (§6).                                 |
| `mail`                                             | BullMQ processor, MJML templates, SMTP transport.                                                                                                                                  | **Broken** — 3 failing tests, real bug (§3).                                          |
| `queue`, `cache`, `maintenance`                    | BullMQ wiring, Redis cache, monthly partition pre-creation.                                                                                                                        | Works.                                                                                |
| `database`                                         | Drizzle schema mirror, `TenantDb` (sets `app.tenant_id` etc. per transaction), privilege self-check at boot (refuses superuser/BYPASSRLS), seeds.                                  | Works. Tenant context via `set_config(..., true)` = `SET LOCAL`. ✅                   |
| `health`, `logging`, `openapi`, `config`, `common` | Liveness/readiness, pino, OpenAPI capture for client generation, zod env, typed exceptions, zod pipe.                                                                              | Works.                                                                                |

Migrations: 22 files (0000–0021), 248 tables (132 of them enum lookup tables). No migration drops or
renames a column or table.

### apps/web (Next.js public site) — typecheck ✅, 29/29 tests

- Tenant resolution in middleware by host, theming, i18n (bn default), SEO (robots, sitemap), areas page,
  typed `apiFetch` with timeout + one retry.
- Media uploader component + upload queue (Week 4). `/dev/forms` and `/dev/upload` previews return
  `notFound()` in production.
- **Placeholders:** `/listing/[id]`, `/map`, `/store/[slug]`, `/info`, `/category/[slug]` render `PlaceholderPage`
  (correctly `noindex`).
- **No auth/session at all.** ADR 024 notes the web auth session is "not yet built". Nobody can post from web.

### apps/admin (Next.js dashboards) — typecheck ✅, 41/41 tests

- Login, token rotation in middleware, dashboard shell, overview, **tenants** list, **roles** management,
  `/dev/forms` preview (prod-gated).
- **Missing:** a category/schema editor (the API exists), and a moderation queue.

### apps/mobile (Flutter) — **tests not run** (see §4)

- go_router shell, splash, tenant bootstrap (24 h cached config), auth (OTP, Google, email), profile + avatar upload
  (real presign/confirm), design system debug screen.
- Week 4: dynamic form renderer (`core/dynamic_form`), resumable compressing upload queue with real Dio transport,
  `form_preview` (debug-only, `kDebugMode`, uses the simulated transport).
- **Placeholders:** `home`, `map`, `info`, `post` screens.
- Google sign-in `--dart-define` values are empty (ADR 020 follow-up). Android `applicationId` and release
  signing are still template TODOs.

### packages

- `dynamic-form` (39/39 tests): shared field-schema → form logic used by web/admin/mobile fixtures.
- `shared-types` (generated API client types), `config`.
- `apps/e2e`: Playwright against a **stub API** (18 web + 24 admin tests). It does not test the real API.

---

## 2. Month 1 plan items missing or incomplete

There is **no written Month 1 plan** in the repo (README is one line). I reconstructed the scope from the
CLAUDE.md phase text (Week 3: client shells; Week 4: category engine, media pipeline, search infra, location
hierarchy) and ADRs 001–026.

| Item                                           | Status                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Week 4 work committed and through CI           | ❌ **Nothing committed.** Only one commit exists.                                                                                                            |
| Schema "complete"                              | ❌ Tables yes (every spec table has a migration). But **24 spec-named DB functions don't exist**; 7 of them matter for Month 2 (§7).                         |
| Every new table: migration + RLS + seed + test | ⚠️ Unverified — RLS for most tables is applied by dynamic `format()` loops, so it can only be checked on a live DB (`audit-schema.sql`, `rls-*.db-spec.ts`). |
| Category engine                                | ✅ API, versioning, dynamic form on all three clients. ❌ No admin editor UI, so categories are seed-only for operators.                                     |
| Media pipeline                                 | ✅ API + web + mobile queues. Web presign/confirm has no real transport (no web auth).                                                                       |
| Search infrastructure                          | ✅ Built. ⚠️ Without a location it filters `tenant_id = X` only (conflicts with new rule 10). Postgres fallback is current-tenant-only by design (ADR 025).  |
| Location hierarchy                             | ✅ Built; boundary editing API exists. `infra/geo/` data is untracked.                                                                                       |
| Real SMS gateway (OTP in production)           | ❌ `BdGatewaySmsProvider.send()` always throws `SMS_PROVIDER_NOT_CONFIGURED`. **Phone login cannot work in production.**                                     |
| Web auth session                               | ❌ Not built.                                                                                                                                                |
| Google OAuth on mobile                         | ❌ Client IDs empty.                                                                                                                                         |
| Brand colours                                  | ❌ Still open since ADR 002.                                                                                                                                 |
| Local test DB setup documented / usable        | ⚠️ `.env.example` has `TEST_*` URLs; the actual `.env` has none, so DB tests have not been run on this machine.                                              |
| CI coverage of API e2e                         | ❌ CI never runs `apps/api` `test:e2e` (8 suites / ~77 tests). Only the Playwright stub suite runs.                                                          |

---

## 3. TODO / FIXME / skipped / stubbed

The codebase is almost free of markers. Every item found:

**TODO / FIXME**

- `apps/mobile/android/app/build.gradle.kts:18` — TODO: set a unique Application ID (still Flutter template).
- `apps/mobile/android/app/build.gradle.kts:31` — TODO: add a release signing config (release builds are debug-signed).

**Skipped tests:** none. No `.skip`, `.todo`, `.only`, `xit` or conditional `describe` anywhere, in TS or Dart.
DB suites fail loudly instead of skipping when `TEST_APP_DATABASE_URL` is missing. That's correct, but it means
they were simply not run here.

**Stubs / placeholders**

- `apps/api/src/auth/otp/sms/bd-gateway-sms.provider.ts` — the real SMS provider is a stub that always throws.
- `apps/api/src/database/seed/data/categories.ts:401` — `bmdc_reg_no` regex is a placeholder (categories.md §7;
  LPG brands, NEIR and Qurbani breeds are also unconfirmed there).
- Web placeholder routes: `listing/[id]`, `map`, `store/[slug]`, `info`, `category/[slug]`.
- Mobile placeholder screens: `home`, `map`, `info`, `post`.
- `apps/e2e/stub-api/` — the whole Playwright suite runs against a hand-written stub server.

**Bugs found during the audit (not marked anywhere)**

1. **Email bodies are never filled in.** `mail/templates/notice.mjml` uses `{{ heading }}` / `{{ body }}` (with spaces).
   `renderMailTemplate` replaces `{{heading}}` (no spaces). Every email goes out with the literal `{{ body }}`.
   This is present since the first commit and causes the 3 failing unit tests.
2. **`PATCH /auth/me` with `displayName` throws `SettingNotFoundException`.** `auth.service.ts:264` reads
   `profile_display_name_max_length`, which is in the registry but seeded by **no** migration.
3. **Mobile OTP resend mismatch.** `otp_verify_screen.dart:20` enables resend after 30 s; the backend seed has
   `otp_resend_cooldown_seconds = 60`. Tapping resend between 30 and 60 s gets an error.

---

## 4. Tests

| Suite                            | Count                 | Result here                                                                                        |
| -------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| api unit (`jest`)                | 59 suites / 481 tests | **478 pass, 3 fail** (`mail/template-renderer.spec.ts` ×2, `mail/mail.processor.spec.ts` ×1)       |
| api DB (`test:db`)               | 21 files / ~413 tests | **Not run** — no Postgres; includes all `rls-*` isolation tests and `schema-audit`                 |
| api e2e (`test:e2e`)             | 8 files / ~77 tests   | **Not run** — all 8 suites fail at setup: `TEST_APP_DATABASE_URL is not set`                       |
| api search (`test:search`)       | 2 files / ~17 tests   | **Not run** — no Meilisearch                                                                       |
| web (`vitest`)                   | 4 files / 29 tests    | ✅ all pass                                                                                        |
| admin (`vitest`)                 | 7 files / 41 tests    | ✅ all pass                                                                                        |
| packages/dynamic-form (`vitest`) | 5 files / 39 tests    | ✅ all pass                                                                                        |
| mobile (`flutter test`)          | 13 files / ~69 tests  | **Not run** — only Windows Flutter at `/mnt/c/flutter`, which can't run from WSL (CRLF / UNC path) |
| Playwright (`apps/e2e`)          | 42 tests              | Not run; against a stub API anyway                                                                 |

"~" counts are static counts of `it(`/`test(` and may be slightly off (`it.each` counts once).

**Coverage (api unit tests only):** lines 56.3 %, statements 55.9 %, functions 39.7 %, branches 47.4 %. The DB
tests cover a lot of what unit tests miss, but that's unmeasured. Web/admin/mobile coverage was not collected.

**Typecheck / lint:** api, web and admin typecheck clean; api eslint clean. Flutter analyze not run.

**Test harness gaps**

- CI does not run `apps/api` e2e.
- No test checks that every `SETTING_DEFINITIONS` key has a seed row, which is how bug #2 slipped through.

---

## 5. `scripts/audit-schema.sql`

**Could not be run.** There is no database: docker is unavailable in this WSL distro and ports 5432/6379/7700 are
closed. Run it with:

```sh
make up && make db-roles-test   # needs docker in WSL
psql "$TEST_DATABASE_URL" -f scripts/audit-schema.sql   # every query must return 0 rows
pnpm --filter @amar-elaka/api test:db                  # includes schema-audit.db-spec.ts
```

In its place I ran a **static approximation** of the 7 checks against the migration SQL:

| Check                                | Static result                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_rls`                        | **Inconclusive.** Most tables get RLS through 26 dynamic `format(... ROW LEVEL SECURITY)` loops, which only a live DB can resolve.                                            |
| `unspecified_on_delete`              | ✅ 511 FK references, all with explicit `ON DELETE` (the one regex hit uses `SET NULL (col)` on the next line).                                                               |
| `float_money_columns`                | ✅ No float/`money` columns. `double precision` appears only in function lat/lng parameters.                                                                                  |
| `timestamp_without_time_zone`        | ✅ None.                                                                                                                                                                      |
| `geography_without_gist`             | ✅ Every geography column has a GiST index (the only uncovered name is a PL/pgSQL local variable).                                                                            |
| `status_deletion_enum_overlap`       | ✅ `post_statuses` (draft…removed) and `post_deletion_reasons` (5 codes) don't overlap.                                                                                       |
| `purge_job_without_legal_hold_check` | ✅ vacuously — **there are no `purge_*` / `scrub_*` / `anonymize_*` DB functions.** Media purge lives in TS and does call `legal_hold_blocks()`, but this check can't see TS. |

---

## 6. Hardcoded durations, limits and prices

`no-hardcoded-numbers.spec.ts` passes. Its blind spots are the reason for this section:

- It scans **only `apps/api/src`**. Web, admin and mobile are not checked.
- It exempts whole folders, including `config/` and `common/`.
- It is silenced by ~100 `// settings-exempt:` markers.

**Flagged — should move to settings or be read from the API**

| Where                                                                                                     | Value                               | Why it's a problem                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/.../otp_verify_screen.dart:20`                                                               | resend cooldown 30 s                | **Already wrong** (backend is 60 s). It should come from the API.                                                                                              |
| `apps/mobile/.../upload_queue.dart:42` and `apps/web/src/lib/media/upload-queue.ts` (`DEFAULT_MAX_ITEMS`) | max 10 photos per upload queue      | A business limit (photos per post) that has **no backend setting and no server-side enforcement yet**. Month 2 posts need `post_max_photos` (or per-category). |
| `apps/mobile/.../image_compressor.dart:11`, `apps/web/src/lib/media/compress-image.ts:9`                  | long edge 1200 px                   | Duplicates `media_variant_full_px` (seeded 1200, bounds 200–4000). Changing the setting silently desyncs the clients.                                          |
| `apps/api/src/search/query/search.service.ts:50`                                                          | `MAX_CATEGORY_SUGGESTIONS = 3`      | Product/UX choice exempted as "layout". Borderline; there is already a `search_suggest_limit` setting.                                                         |
| `apps/api/src/config/env.schema.ts:113` (exempt folder)                                                   | `PERMISSIONS_CACHE_TTL_MS = 300000` | A revoked role keeps working for up to 5 min. It's env-tunable, but it's a security behaviour, not infra.                                                      |

**Reviewed and acceptable:** input-length caps in DTOs; lat/lng ranges; HTTP codes; unit conversions; S3/Meili/SMTP/Barikoi
timeouts and retries; outbox/indexer batch sizes and leases; cron schedules; argon2 cost; presign TTL 300 s; ThumbHash and
geodesy constants; mobile retry delays (2/6/20 s) and network timeouts; `tenantConfigTtl` 24 h (client cache). SQL-side intervals
are only `interval '1 month'` for partition math. The one DB-level threshold (`agent_visit_edit_window_hours`) is read from
`platform_settings`.

**Settings parity**

- Registry: 81 keys; seeded rows: 80.
- `profile_display_name_max_length` — in the registry, **not seeded** (causes bug #2).
- `agent_visit_edit_window_hours` — seeded and read by a DB trigger, **not in the registry**.
- 18 registry keys (otp__, media__, `auth_password_min_length`, `tenant_nearby_max_radius_km`, …) are not listed in spec §2.16.

---

## 7. `docs/specs/schema.md` vs migrations

**Tables:** all 114 spec tables exist in migrations. ✅

**In migrations, not in spec** (all additions, nothing contradicts)

- Tables `roles`, `role_permissions` (0015).
- Columns `users.password_hash`, `users.google_id` (0013), `tenants.custom_domain` (0014), `tenant_members.custom_role_id` (0015).
- Function names that differ from the spec: `auth_resolve_or_create_by_phone` (spec: `auth_upsert_user_by_phone`).
  Spec'd DB functions replaced by TS: `audit_row_change` → `rbac/audit-log.interceptor.ts`, `effective_setting` →
  `SettingsService`, `purge_media_assets` → `media-maintenance.service.ts`. The spec was not updated for any of these.

**In spec, no migration** — the functions (spec §0.6 SECURITY DEFINER table and §11). This contradicts "schema is complete":

| Month 2 needs it                                                                        | Later months                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `resolve_owning_tenant` — which tenant owns a new post                                  | `credit_apply`, `request_closure_refund`, `backfill_platform_share_rates`                         |
| `discover_nearby` — the DB radius-discovery fallback across tenants                     | `live_ads`                                                                                        |
| `scrub_post` — the one-transaction takedown scrub (requires a `moderation_actions` row) | `appeal_submit_in_app`, `public_appeal_submit`, `public_appeal_status`, `staff_open_conversation` |
| `reveal_contact_phone` — show a seller's phone, write the lead event, rate limit        | `purge_archived_tenant_data`, `purge_message_bodies`, `purge_verification_documents`              |
| `user_is_visible` — hide banned/deleted authors without SELECT on `users`               |                                                                                                   |
| `neighbour_landmarks` — landmarks across the boundary                                   |                                                                                                   |
| `app_verified_phone` — RLS helper in §0.6                                               |                                                                                                   |

Adding these is a **new migration**, which the phase rules allow. It isn't a schema change to existing tables.

---

## 8. Top 5 risks for Month 2

1. **Posts will be tenant-visible, not radius-visible.** `posts_public_read` is `tenant_id = current_tenant_id()`, and
   `discover_nearby` / `resolve_owning_tenant` don't exist. If the feed, map or post detail are built as normal
   `TenantDb` queries, they will quietly honour tenant boundaries — the exact thing rule 10 forbids — and every
   cross-boundary search hit will 404 on click. **Decide the pattern first:** SECURITY DEFINER discovery returning
   `(id, tenant_id, distance)`, then read each row in its owner's context (§13.26). Build it with its RLS tests _before_ any feed
   code. The no-location search path (`filter-builder.ts:66`, tenant-only) needs the same decision.
2. **Building on unverified ground.** ~500 DB, e2e and search tests, the RLS isolation suite and `audit-schema.sql` have not run
   against the Week 4 schema anywhere, and CI never runs API e2e. Get docker working in WSL (Docker Desktop → WSL
   integration), fill `TEST_*` in `.env`, run `test:db`, `test:e2e`, `test:search` and the audit. Add API e2e to CI. Commit Week 4
   in reviewable chunks. Until then, "green" means unit tests only, at 56 % line coverage.
3. **Takedown / scrub has no implementation.** Posts bring moderation. The rules say every takedown writes `moderation_actions`,
   every scrub checks legal holds, and `moderator_removed` requires `scrubbed_at` (a CHECK constraint). `scrub_post()` doesn't exist,
   and the audit's legal-hold check only sees DB functions. A TS scrub path would be invisible to it. Write `scrub_post` as a DB
   function (as the spec says), or extend the audit to cover TS.
4. **Limits that posts need don't exist as settings, and clients already hardcode them.** Photos per post (10, client-only),
   image size (1200, duplicated), OTP cooldown (already wrong). Month 2 adds more: title/description length, price range,
   feed page size, map cluster limits. Add settings with the post work, have clients read them from `tenant/config`, and add a
   registry ↔ seed parity test so bug #2 can't recur.
5. **Nobody outside dev can actually use it.** No production SMS gateway (phone OTP always fails), no web auth (can't post from
   web), empty Google client IDs, and the Android app still ships the template application ID with debug signing. Email is
   broken too. None of this blocks writing Month 2 code, but a pilot tenant can't sign up. Pick the SMS provider now, because it
   has lead time (sender ID registration with BTRC/operators).

**Smaller things:** add a `post_max_photos` setting before the post form hardens; web middleware `tenants/resolve` has a
timeout but no retry (rule 5); reconcile `agent_visit_edit_window_hours` into the registry; update schema.md for
`roles`/`role_permissions`, the auth columns and the renamed/TS-moved functions; the admin category editor is out of scope
for Month 2 ("no admin dashboards beyond moderation queue"), so category changes stay seed-and-migrate for now.

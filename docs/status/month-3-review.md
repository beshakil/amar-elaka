# Month 3 review: repo audit before Month 4

Audited 2026-10-16 on `main` from `5cb20e5`. The Month 3 tail (information services, the info engine, field agent mode)
is committed as `ad9214a` and this review's fixes as `50b2843`. As in Month 2, the review also **changed code**.
Each fix is in "Fixed during this review" and marked _fixed_ where it comes up below.

Measured on the dev laptop (WSL, about 3–4× slower than a server; see the `local-test-stack` notes) with local Postgres
16 + PostGIS, Redis and Meilisearch 1.8. **No server exists**, so the sections the brief asks to measure "in staging"
or "in production" (§13, §15, §16) measure what the laptop can and give the exact queries to run on day one of a
deployment.

## Fixed during this review

| Fix                                                                                                                                                                                                                                                                             | Why it mattered                                                                                                                                                                                                                                                                   | Where                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bans now bite on the chat socket.** Banned and terminated accounts can't connect or refresh the socket's token; a restricted account can read, mark read and join, but `message:send` and `typing` answer `ACCOUNT_RESTRICTED`. Every event re-checks the (cached) ban state. | The socket checked the JWT once and never the ban. A user banned mid-conversation kept messaging for the rest of the access token's life, and a restricted user (ADR 063: "may not start or write a chat") could write over the socket while HTTP refused them.                   | `chat/realtime/chat-socket.server.ts`; the rule moved into `enforceBanAccess()` (`auth/guards/ban-enforcement.ts`) so HTTP and the socket share one implementation; e2e in `chat.e2e-spec.ts` |
| **Restricted accounts can no longer add or edit places, claim a place, or create or edit a store.**                                                                                                                                                                             | ADR 063 says restricted = "may not publish". Posts, chat and reviews were guarded; places (0040s) and stores (0050) were not, so a restricted seller could keep publishing through the map and the store page.                                                                    | `@ActiveAccountRequired()` on 5 routes in `places.controller.ts`, `place-claims.controller.ts`, `stores.controller.ts`; ADR 063 table amended; e2e loop in `bans.e2e-spec.ts`                 |
| **Signed (private) reads are no longer cacheable.** Local driver: `Cache-Control: private, no-store` on token-granted reads; S3 driver: `ResponseCacheControl` on the presigned GET.                                                                                            | Verification evidence (NID photos) was served with the media default `private, max-age=31536000, immutable`, so a phone, browser or proxy could keep an NID image for a year after its 5-minute URL expired, and after the retention purge.                                       | `storage/local/local-storage.routes.ts`, `storage/s3-storage.service.ts` (+ unit test); asserted in `verification.e2e-spec.ts`                                                                |
| **The public appeal OTP endpoint no longer leaks whether a phone has a ban.**                                                                                                                                                                                                   | It always answered 202 with the same body (good), but sent the SMS inline only when a ban existed, so the response time told an attacker which phone numbers are banned. The SMS now goes out after the response.                                                                 | `bans/appeals.service.ts`; tests wait for the SMS                                                                                                                                             |
| **Phone-type category fields never reach a card or a detail's field list.**                                                                                                                                                                                                     | Month 2's gap #1, still open: a category with an `x-field-type: phone` field (e.g. "contact number" on a service post) rendered it in post detail, SEO HTML and search cards, around the contact endpoint and its `lead_event`.                                                   | `categories/field-schema/field-renderer.ts`, `search/documents/document-builder.ts`, with specs                                                                                               |
| **A ban changes the trust score at once.**                                                                                                                                                                                                                                      | Bans feed `member_trust_scores.components.bans` (ADR 061), but only the nightly recompute picked them up: a freshly banned seller kept a clean score (and skipped pre-moderation) until the next night. Issue, lift, expiry and appeal decision now recompute the member's score. | new `bans/ban-effects.ts`, used by `bans.service.ts`, `bans-jobs.service.ts`, `appeals.service.ts`; asserted in `bans.e2e-spec.ts`                                                            |
| **A capped notification is now logged.**                                                                                                                                                                                                                                        | Capping was silent: no row, no log. Nobody could tell on a server whether caps bite (§15).                                                                                                                                                                                        | `notifications/notification-dispatcher.ts` (`notification capped`, with the day's counts)                                                                                                     |
| **Times on the web read in Bengali.** `bn-BD` with a 12-hour clock prints English "AM"/"PM" ("৪:৪১ AM"); prayer times, info cards, transport and the seller import history now use Bengali day periods ("৪:৪১ ভোর", "১০:১০ রাত্রি").                                            | Rule 6: no English user-facing text on a Bengali page; prayer times are read by people who don't read "AM".                                                                                                                                                                       | `apps/web/src/lib/info/engine-format.ts` (+ test), `seller/[storeId]/import/import-flow.tsx`                                                                                                  |
| **`docs/runbooks/` exists.**                                                                                                                                                                                                                                                    | The brief asks for every runbook's exercise date; there was no runbooks directory. Ten runbooks now, each with its honest "last exercised".                                                                                                                                       | `docs/runbooks/` (§12)                                                                                                                                                                        |

## TL;DR

Month 3 built everything in the weeks 10–14 plan **except the first production deployment**. Stores, seller tools,
chat, notifications, reviews, verification, bans and appeals, two rounds of information services and field agent mode
all exist with migrations, RLS, seeds and tests, and every suite passes (§4).

What did not move is the part that needs a server:

- **Nothing is deployed anywhere.** There is no staging and no production. `amarelaka.com` serves an unrelated static
  site, `api.amarelaka.com` doesn't resolve. The Month 2 deploy blockers are all still open: the API image can't run
  migrations, web and admin have no images, CI builds none, there is no SMS account, no crash reporting, no backups.
- **So everything "in staging" in this brief is unmeasured.** Notification volume, disk growth and runbook drills are
  laptop measurements plus projections, and §13/§15/§16 give the queries to run on the first day of a server.
- **The security review found four real holes, all fixed above:** bans not enforced on the socket, restricted users
  publishing places and stores, NID images cacheable for a year, and a timing oracle on the public appeal endpoint.
- **Month 4 is money.** It should not start on code no real user has touched. §17 says what has to exist first.

---

## 1. What exists and works

"Works" means typecheck, lint and the unit, DB and e2e suites pass (§4) against real Postgres, Redis and Meilisearch.

### apps/api: Month 3 modules

| Module                    | What's there                                                                                                                                                                                          | State                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `stores`                  | Stores (one per seller per tenant), store pages, catalog, bulk CSV/XLSX import with dry run, WhatsApp catalog import, seller analytics, seller dashboard API (ADR 054–057)                            | Works                                 |
| `chat`                    | Conversations per post/store/place, messages with attachments, read/delivered receipts, Socket.IO (ws only, Redis adapter), inbox, blocks and reports (ADR 058, 060)                                  | Works; _fixed_: bans on the socket    |
| `notifications`           | One dispatcher: in-app inbox + push (FCM), SMS, email channels; preferences, quiet hours, collapse, daily and per-type caps, outbox relay; every pending notification from weeks 5–10 wired (ADR 059) | Works; see §15 for one dead cap       |
| `reviews`, `seller-score` | Reviews with prompts after contact, replies, photos, moderation; seller score formula (ADR 061)                                                                                                       | Works                                 |
| `verification`            | Phone/NID/trade-licence verification; NID stored only as peppered HMAC + last 3 digits; evidence purged after retention, legal holds respected (ADR 062)                                              | Works; _fixed_: evidence caching      |
| `bans`                    | Three severities (restricted, banned, terminated), the ladder, appeals (signed-in and public by OTP), complaints, global blacklist with two-person governance, ban cache (ADR 063)                    | Works; _fixed_: scopes, timing, trust |
| `info`                    | Emergency numbers, blood donors and requests with capped alerts, bazar prices with trends (ADR 064)                                                                                                   | Works                                 |
| `info-engine`             | Outages, transport, notices, prayer times, lost & found, government services guide, agriculture, directories, info feed and moderation (ADR 065)                                                      | Works                                 |
| `agents`                  | Field agent mode: agents, tasks, today's route, offline capture with exactly-once sync, duplicate-on-sync, GPS accuracy floor, anti-fraud flags, commission report (ADR 066)                          | Works                                 |

Migrations: **63** (0000–0062), each with a journal entry and snapshot. Month 3 added 0050–0062. None drops or renames
a column. ADRs 054–066.

### Clients

- **Mobile (Flutter):** store page and my store, seller dashboard, chat (realtime, offline outbox), notification inbox
  and preferences, reviews, verification, account bans and appeals, info hub (all ADR 064/065 services), field agent
  mode (today, capture offline, sync queue, my numbers).
- **Web:** store pages, seller panel (dashboard, catalog, import), inbox and chat, notifications, reviews, the public
  appeal page, info pages.
- **Admin:** moderation (posts, places, reviews, verification, complaints, appeals, bans, blacklist), local info
  moderation, agents (list, tasks, review queue, commission report), platform.

---

## 2. Month 3 plan items

| Week | Item                                                                                                              | Status                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 10   | Stores, seller dashboard, bulk upload, WhatsApp catalog, seller web panel                                         | ✅                                                           |
| 11   | Realtime chat; notification infrastructure (push, SMS, email, in-app); wire every pending notification            | ✅ (SMS and push need provider accounts to work outside dev) |
| 12   | Reviews, seller score, verification, complaints, bans with three severities, appeals, global blacklist governance | ✅ (_fixed_: four enforcement gaps above)                    |
| 13   | Information services                                                                                              | ✅ (two rounds: ADR 064 and 065)                             |
| 14   | Field agent mode                                                                                                  | ✅ (ADR 066)                                                 |
| —    | **First production deployment**                                                                                   | ❌ **not done** (§13)                                        |

---

## 3. TODO / FIXME / skipped / stubbed

- **TODO / FIXME:** none in `apps/*/src`, `apps/mobile/lib` (the two Android TODOs from Month 1 are gone).
- **Skipped tests:** none (no `.skip`, `.only`, `xit`). **But** the Flutter `test/features/offline_map/*` socket tests
  are left out of the local regression run because they hang in this WSL setup; CI runs them.
- **Stubs and dev-only paths:** dev SMS is `LocalSmsProvider` (logs the OTP); the email channel needs SMTP settings;
  push needs `FCM_SERVICE_ACCOUNT_JSON`. Playwright still runs against the stub API.
- **Settings promised but not enforced** (new this month, see §8): `message_body_retention_days`,
  `lead_event_retention_months`, `activity_log_retention_days`.

---

## 4. Tests

| Suite                           | Result (2026-10-16, full serial run)                                         |
| ------------------------------- | ---------------------------------------------------------------------------- |
| API typecheck / lint            | ✅ / ✅                                                                      |
| API unit                        | ✅ 1012/1012                                                                 |
| API DB (`test:db`)              | ✅ 792/792                                                                   |
| API e2e (`test:e2e`)            | ✅ 387/387                                                                   |
| API search e2e                  | ✅ 46/46                                                                     |
| Admin typecheck / lint / vitest | ✅ / ✅ / 56                                                                 |
| Web typecheck / lint / vitest   | ✅ / ✅ / 126                                                                |
| Web and admin production builds | ✅                                                                           |
| Flutter format / analyze / test | ✅ / no issues / 365/365 (offline_map socket tests excluded locally, see §3) |
| Playwright (stub API)           | ✅ 36/36                                                                     |

Month 2 → Month 3: unit 873 → 1012, DB 612 → 792, e2e 261 → 387, Flutter 266 → 365, web vitest 87 → 126.

Notes:

- The suites still have to run **one after another** on the laptop (about 30 minutes now). CI runs them in separate
  jobs.
- **Playwright found a time-of-day bug.** The info engine test failed after 22:00: from Isha to Fajr the "next prayer"
  line also says ফজর, so the locator matched twice. _Fixed_ (exact match). The same failure showed the web printing
  "৪:৪১ AM" on a Bengali page — _fixed_ too (see the top table). One later full run failed once straight after a
  rebuild without a captured error; the next three runs, alone and in full, passed 36/36.
- Test hygiene held: no fixture leaks this month. The one restore error found in §12's drill comes from test clean-ups
  that delete with triggers off, in the _test_ template only.

---

## 5. `scripts/audit-schema.sql`

Run by the DB suite against the fully migrated test DB (63 migrations): **all checks return 0 rows** — RLS on every
tenant table, `ON DELETE` specified, no float money, no `timestamp` without time zone, GiST on every geography, no
status/deletion overlap, every purge function checks legal holds.

The legal-hold check sees only DB functions, so the Month 3 TS paths were read by hand:

- **Check `legal_hold_blocks`, in SQL (so the audit sees them):** `purge_verification_documents()` (0058) and
  `scrub_review_author()` (0057). The store bulk paths (0053) leave legal-hold-removed posts alone.
- **Not purges:** the info deletes (bazar items, transport stops and schedules) replace an editor's own configuration.
- **No purge exists to check:** chat message bodies and lead events are never purged (§8) — when someone writes those
  purges, they must check holds.

---

## 6. The same logic in more than one place

### Ban enforcement ⚠️ → ✅ (_fixed_: `enforceBanAccess`)

HTTP had one implementation for both JWT guards; the socket had none. Now both call `enforceBanAccess()`.

### Trust score ✅

One `TrustScoreService.recompute`; bans now call it too (_fixed_) instead of waiting for the night.

### "What a card shows" ⚠️ → ✅ (_fixed_)

`renderFields` (detail, SEO) and `cardFields` (search documents) each decided which fields to show; both now skip phone
fields with the same test.

### Visibility, open-now, tenant assignment, filters ✅

Still one implementation each (0049), and the Month 3 surfaces call them rather than copying them: agent shops become
ordinary places (same duplicate and open-now rules); information services are radius-based from the viewer and never
filter by `tenant_id` alone.

### Still two copies (accepted)

- **OTP length:** the app's `_codeLength = 6` (`otp_verify_screen.dart:17`) mirrors the server setting. Open since
  Month 2.
- **GPS accuracy floor:** the agent app checks `agent_min_gps_accuracy_m` before saving, and the API refuses it again.
  Deliberate (offline capture), both read the same setting.

---

## 7. Geo cost review

Unchanged from Month 2: **no real calls have been made**, so there is nothing to measure. Month 3 added **no new
Barikoi caller**: field agent capture takes the position from the phone's GPS and the locality from our own geo areas,
and the information services (outages, lost & found, transport, directories) use our own places and geo areas. Every
call still goes through `GeoProvider` with cache and budget. The agent drive will add map loads (self-hosted tiles,
free), not geocoding calls.

Still open from Month 2: the Barikoi plan's quota is not recorded in ADR 044, so `barikoi_daily_call_budget` is a
guess.

---

## 8. Numbers in business logic that should be settings

- The `no-hardcoded-numbers` spec passes; 390 `settings-exempt` markers, each with a reason (unit conversions, protocol
  constants).
- **Dead setting combination:** `notification_type_daily_caps.new_message = 30` can never bite, because the daily cap
  for all types (`notification_daily_cap = 20`) is checked first. Chat pushes stop at 20 a day in total. Someone has to
  decide: either chat is exempt from the daily cap or its type cap should be ≤ 20 (§15).
- **Settings with no code behind them** (retention promised to users and not kept):

  | Setting                             | Promises                                              | Reality                                                                                                                         |
  | ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
  | `message_body_retention_days` (180) | chat bodies deleted after 180 days                    | no purge exists; bodies kept for ever. Needs a product call first (the `messages` content CHECK requires a body or attachment). |
  | `lead_event_retention_months` (13)  | lead events (who revealed whose phone) kept 13 months | kept for ever                                                                                                                   |
  | `activity_log_retention_days`       | activity logs pruned                                  | nothing writes `activity_logs` yet, and no job creates partitions after 2027-01 — latent                                        |
  | —                                   | notifications and deliveries                          | **no retention setting at all**; they are the largest weekly DB growth (§16)                                                    |

  These are privacy promises: they should be closed before a real user's data exists, not after.

---

## 9. Query performance

**Not re-measured this month.** The Month 2 method (seed + volume script, `pg_stat_statements`, the 10 slowest) needs a
volume script per new surface, and the month's time went into the four security holes instead. The new hot paths and
what protects them:

- Chat inbox: unread counts are a per-participant counter kept by a trigger (0054), not a count per request.
- Notification caps: `sentSince` counts today's deliveries for one user on `notification_deliveries_user_day_idx`
  `(user_id, created_at)` (0055); one query per dispatched notification.
- Info feed and agent "today": radius queries on GiST indexes, like the feed.

Re-run the Month 2 perf setup with Month 3 volumes before the pilot (§17, risk 5).

---

## 10. Phone walkthrough

**Not walked on a device this month.** The emulator used in Month 2 (`adb 127.0.0.1:5555`) was not available. The
Flutter widget and integration tests cover the new screens (§4), but nobody has held the Month 3 app in their hand:
chat, notification taps, store pages, the appeal flow and field agent capture in a weak-GPS street all need a real
phone walk before the pilot. The Month 2 checklist (§10 of that review) still applies; add:

1. Chat with the API restarted mid-conversation: messages queue and send on reconnect.
2. Push arrives with the app killed; tapping it opens the right screen.
3. A restricted account: chat opens and reads, send is refused with the Bengali message.
4. Agent mode in airplane mode: capture 3 shops, turn the network on, all three sync once.

---

## 11. `docs/specs/schema.md` vs migrations

- **Tables:** all 34 tables added by 0050–0062 have sections, with scope, columns and RLS.
- **Migration notes:** 0050–0062 each have one.
- **Not reconciled (as in Month 2):** the Month 3 SQL functions are documented in their migration headers and ADRs, not
  in `schema.md` §11.

---

## 12. Production readiness: the runbooks

`docs/runbooks/` is new this review. "Exercised" means run end to end, with the result checked.

| Runbook                                 | Exercised at least once? | When / where        | Result                                                                                                                                                          |
| --------------------------------------- | ------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy on Coolify                       | **No**                   | —                   | Can't be: blocked (API image has no migrations, no web/admin images, no SMS account)                                                                            |
| Migrations                              | Yes, **locally only**    | 2026-10-16, test DB | 0000→0062 on a fresh DB, many times; never on a server and there is no prod migrate command                                                                     |
| Backup and restore                      | Yes, **locally only**    | 2026-10-16          | Dump 3.1 MB, restore 9 s, row counts and all 823 RLS policies identical; 2 restore errors traced to test-template orphans. **No backup is scheduled anywhere.** |
| Search reindex                          | Yes, **locally only**    | 2026-10-16          | 30 posts, 10 stores, 20 places in 4 s; exits 0 (it hung in Month 2)                                                                                             |
| Storage check                           | Yes, **locally only**    | 2026-10-16          | All PASS, including "anonymous read of a document is refused"                                                                                                   |
| Base map build                          | Yes, **locally only**    | 2026-10-05          | `bd-20261005.pmtiles`, 199 MB                                                                                                                                   |
| Secrets rotation                        | **No**                   | —                   | Written; rotating `NID_HASH_SECRET` breaks duplicate-NID detection (no re-hash path)                                                                            |
| Provider incidents (SMS, Barikoi, push) | **No** (tests only)      | —                   | Fallbacks tested; no alerting exists                                                                                                                            |
| Legal holds and personal data           | **No** (DB tests only)   | —                   | **No API or screen** to place a hold: SQL by a platform admin. No account deletion.                                                                             |
| Rollback                                | **No**                   | —                   | Additive migrations make code rollback safe; never drilled                                                                                                      |

**Production readiness verdict: not ready.** Before the first real user, in order: an image that can migrate; images
for web and admin built in CI; the SMS account; nightly off-site backups of Postgres **and** the storage volume (the
photos and documents exist nowhere else); crash reporting; then deploy and run the storage check, a restore drill and
a reindex **on the server**, and update the dates above.

---

## 13. What runs only on staging and not production

**Nothing — there is no staging either.** As of 2026-10-16:

- No staging or production host, credentials or Coolify project are referenced in the repo or on this machine.
- `amarelaka.com` (199.250.210.129, nginx 1.14.1) serves a different static site ("আমার এলাকা — এলাকার সমস্যা রিপোর্ট
  করুন"), not this codebase. `api.amarelaka.com` doesn't resolve.
- Everything in this codebase has run only on the dev laptop and in CI.

So the honest answer to "what runs only on staging" is everything, and it runs only locally. When servers exist,
everything that needs a provider account will be the first gap between them: SMS (BulkSMSBD sender ID and IP
whitelist), FCM push, email (SMTP), Barikoi's paid key, S3 (if chosen over the local driver).

---

## 14. Security review

Scope: chat sockets, document storage, signed URLs, NID handling, ban scopes and the public appeal endpoints. Read
end to end, then attacked with e2e tests where something looked wrong.

### Chat sockets

| Check                 | Finding                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth on connect       | ✅ JWT checked in the handshake; `auth:refresh` re-verifies; expired tokens disconnect                                                                                 |
| Tenant and membership | ✅ Every event runs in a tenant context; RLS (`ChatScope`) decides which conversations a socket may join or write                                                      |
| Transport             | ✅ WebSocket only (no long-polling fallback to hijack); Redis adapter for multiple API instances                                                                       |
| Bans                  | ❌ → ✅ _fixed_: the ban was never checked. Now checked on connect, refresh and every event                                                                            |
| Payload               | ✅ zod on every event (strict schemas); phone numbers are not part of any chat payload                                                                                 |
| Abuse                 | ⚠️ `typing` events are not throttled and there is no per-user connection cap. Low risk (a user can only spam their own conversations); add both before a public launch |

### Document storage and signed URLs

| Check               | Finding                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Documents bucket    | ✅ Never public: no anonymous route, storage check proves a 404                                 |
| Local driver tokens | ✅ HMAC over bucket + key + expiry, compared timing-safe; a token can't be moved to another key |
| S3 driver           | ✅ Presigned GET per read, never a public ACL                                                   |
| TTLs                | ✅ Verification evidence 300 s, notice attachments 600 s, both settings                         |
| Caching             | ❌ → ✅ _fixed_: signed reads were `max-age=31536000, immutable`; now `private, no-store`       |
| Keys                | ✅ Server-generated (uuid v7 paths); a client never chooses a key                               |

### NID handling

| Check           | Finding                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage         | ✅ The NID number is never stored: a peppered HMAC (`NID_HASH_SECRET`) for duplicate detection + the last 3 digits for display                   |
| Logs            | ✅ pino redacts `req.body.nid`, `*.nid`, `nid`; validation errors echo the path and message only, never the value                                |
| Evidence images | ✅ Documents bucket only; purged after `verification_doc_retention_days`; the purge checks legal holds; _fixed_: no longer cacheable             |
| Pepper          | ⚠️ Rotating `NID_HASH_SECRET` silently breaks duplicate detection (runbook written). Keep it out of every env file but production's secret store |

### Ban scopes

| Check               | Finding                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banned / terminated | ✅ Appeal-only scope token, DB role `restricted_user`; everything else 403                                                                         |
| Restricted          | ❌ → ✅ _fixed_: could still add/edit places, claim places, create/edit stores; and write on the socket                                            |
| Cache               | ✅ `ban_state_cache_seconds` (60 s); invalidated on issue, lift, expiry and appeal decision, so the 60 s is a ceiling only for other API instances |
| Trust               | ❌ → ✅ _fixed_: the score now follows a ban at once                                                                                               |

### Public appeal endpoints

| Check       | Finding                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enumeration | ✅ Always 202 and the same body, whether or not the phone has a ban. ❌ → ✅ _fixed_: the response **time** still told (SMS sent inline only for banned phones) |
| OTP         | ✅ Separate OTP purpose, the same rate limits and lockout as sign-in                                                                                            |
| After OTP   | ✅ A single-use random token in Redis, scoped to that phone's appeals; no session, no JWT                                                                       |
| Content     | ✅ zod with length limits; moderators see appeals through RLS                                                                                                   |

**Not reviewed:** dependency CVEs (no `pnpm audit` / `flutter pub outdated` gate in CI), and infrastructure (no server
to review).

---

## 15. Notification volume per user per day — are caps working?

### In staging: not measurable

There is no staging (§13), so there is no real volume. Until this review a capped notification also left no trace, so
even a server couldn't have answered; _fixed_: the dispatcher now logs `notification capped` with the day's counts.

### The caps, and proof they work

| Setting                                                                     | Value                                                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `notification_daily_cap` (interruptions, all types, per user per local day) | 20                                                                                                          |
| `notification_type_daily_caps`                                              | `new_message` 30, `saved_search_match` 6, `post_expiring` 5, `saved_post_price_drop` 5                      |
| `blood_donor_alerts_per_day` (separate, per donor)                          | 2                                                                                                           |
| Quiet hours (push and SMS held, not dropped)                                | 22:00–08:00 tenant time                                                                                     |
| Never capped (urgent)                                                       | `blood_request_nearby`, `ban_issued`, `ban_lifted`, `appeal_decided`, `store_suspended`, `store_reinstated` |

- Caps count **interruptions** (push, SMS, email deliveries), not inbox rows. A capped notification still lands in the
  in-app inbox.
- They are proven by `delivery-policy.spec.ts` (every rule, unit) and `notifications.e2e-spec.ts` ("past a cap … urgent
  types are never capped", end to end through the queue).
- **Two findings:**
  1. **The `new_message` cap of 30 is dead** (§8): the all-types cap of 20 bites first, so a busy seller gets no chat
     pushes after their 20th interruption of the day — including chats from buyers. Recommendation: exempt
     `new_message` from the daily cap and keep its own cap (30), since chat is the one notification a seller wants.
     Needs a product decision, not changed here.
  2. **A delivery counts per channel.** One notification sent as push + email counts 2 toward the 20, so a user with
     email verified hits the cap at half the notifications. Probably intended ("interruptions"); write it down in
     ADR 059 either way.

### Projected volume (assumption, not data)

For a pilot user, interruptions per day before caps: chat 0–10 (sellers more), saved-search matches 0–6, price drops
0–3, post expiry 0–1, reviews and prompts 0–2, info alerts (outages, notices, blood) 0–3. **Typical: 2–6. A busy
seller: 20+, which is where the dead chat cap matters.**

### Queries to run on the first server (day one, then weekly)

```sql
-- Interruptions per user per local day: median, p95, max, and how many users hit the cap.
with per_user_day as (
  select d.user_id, (d.created_at at time zone 'Asia/Dhaka')::date as day, count(*) as n
  from notification_deliveries d
  where d.channel_code <> 'in_app' and d.created_at > now() - interval '14 days'
  group by 1, 2)
select day, count(*) as users,
       percentile_cont(0.5) within group (order by n) as median,
       percentile_cont(0.95) within group (order by n) as p95,
       max(n) as max,
       count(*) filter (where n >= 20) as at_daily_cap   -- the current notification_daily_cap
from per_user_day group by day order by day;

-- Inbox rows per user per day by type (everything, capped or not).
select type_code, (created_at at time zone 'Asia/Dhaka')::date as day,
       count(*)::numeric / count(distinct user_id) as per_user
from notifications where created_at > now() - interval '14 days'
group by 1, 2 order by 2, 3 desc;
```

And from the worker logs: `grep '"notification capped"' | jq -r .type | sort | uniq -c`. **Caps are working** when
`max` never exceeds 20 + the urgent ones, and `at_daily_cap` is a small minority of users; if it's more than a few
percent, the caps are hiding real messages.

---

## 16. Disk usage projection

### Current usage by volume (measured on the laptop; no server exists)

| Volume                                     | Now                                                 | What's in it                                                                                  |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Postgres                                   | **212 MB** (seeded test DB, 313 tables)             | Almost all reference geography (divisions to wards, landmarks, places); live data is a few MB |
| Storage `/app/storage/media`, `/documents` | ~6 MB (dev uploads)                                 | Photos and their variants; verification evidence                                              |
| Storage `/app/storage/map`                 | **199 MB**                                          | `bd-20261005.pmtiles`; the build keeps the previous archive, so plan **~400 MB**              |
| Meilisearch                                | 355 MB (dev instance, mostly leftover test indexes) | A clean index of the seed is a few MB                                                         |
| Redis                                      | < 1 MB                                              | Sessions, caches, queues; bounded by TTLs                                                     |
| Backups                                    | 0 — **none are taken**                              | A compressed dump of the seed is 3.1 MB                                                       |

### Growth per week (projection for one pilot thana)

Assumptions, all stated so the first real week can replace them: **2,000 daily active users, 150 new posts a day with
3 photos, 300 chats a day of ~20 messages, 5 interruptions + 5 inbox rows per active user a day**. Row sizes are
measured (`pg_column_size` on the seed) plus ×2.5 for indexes and TOAST; the photo size is computed from the variant
settings (original kept + 1200/600/200 px WebP at q80) at ~350 KB per photo — an estimate, as no real photo has been
stored.

| Volume                                 | Growth / week                                             | Driver                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Storage (photos)**                   | **~1.1 GB**                                               | 150 × 3 × 350 KB × 7; plus ~0.25 GB of store, place, review, chat and info photos                                                                      |
| Storage (one-off)                      | ~0.2 GB                                                   | The agent drive: 300+ shops × 2 photos                                                                                                                 |
| **Postgres**                           | **~90–100 MB**                                            | Notifications + deliveries (~70 MB, no retention, §8), messages (~15 MB), search queries, lead events, audit logs (the rest). Posts themselves: < 1 MB |
| Meilisearch                            | ~10 MB                                                    | Documents per post/store/place; reindex rebuilds it                                                                                                    |
| Backups (if 14 nightly dumps are kept) | ~+15 MB/week of dump size                                 | ~10:1 compression of the DB                                                                                                                            |
| Logs                                   | **unbounded** unless Coolify's Docker log rotation is set | pino JSON per request                                                                                                                                  |

**One thana: ~1.4 GB a week, ~75 GB a year, ~90 % of it photos.** A Contabo VPS with 200–400 GB fits a year of the
pilot and about 3–5 thanas — after which the S3 driver (ADR 027) is the plan, not a bigger disk. Notifications are the
only DB table growing without bound; add a retention setting and purge before the second thana.

### Measure on the server (weekly, into this table)

```sh
docker system df -v                                   # every volume
du -sh /app/storage/{media,documents,map}             # inside the api container
psql -c "select pg_size_pretty(pg_database_size(current_database()));"
psql -c "select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class
         where relkind in ('r','p') order by pg_total_relation_size(oid) desc limit 15;"
```

---

## 17. Top 5 risks for Month 4 (credits, boosts, subscriptions, payment gateways)

1. **Money code on a platform with no users, no server and no backups.**
   - Month 2's top risk, unchanged: nothing is deployed, so the money month would be the first contact with production.
     A payment that succeeds at the gateway and fails in our DB has no backup to reconcile against and no crash report
     to notice it.
   - **Before any money code merges:** deploy (§12's order), nightly off-site backups with one restore drill **on the
     server**, Sentry (or equal), and a closed pilot without money for at least two weeks.
2. **Gateway callbacks are the new public endpoint, and the appeal endpoint showed how those go wrong.**
   - bKash/Nagad/SSLCommerz callbacks are unauthenticated, retried, arrive out of order and can be forged. This review
     found an enumeration leak in the one public endpoint we had.
   - Verify every callback by the gateway's signature **and** by a server-to-server status query; treat the gateway
     transaction id as an idempotency key with a unique index; never credit on the redirect, only on the verified
     callback; e2e tests for duplicate, late, forged and out-of-order callbacks.
3. **Credit balance correctness (rule 2).**
   - Double spend under concurrency, refunds, boosts that end early, a moderator removing a boosted post, a ban
     mid-boost, a tenant terminated with balances.
   - One append-only ledger (`credit_transactions`) with the balance derived or updated in the same transaction under
     `select … for update`; integer poisha only; a DB test that fires concurrent spends at one wallet; a nightly
     reconciliation job that compares ledger sums to balances and to gateway settlements, and alerts.
4. **"Is this live?" rules multiply — the drift this project keeps finding.**
   - Is a boost live (paid, started, not ended, post still listed, seller not banned)? Is a subscription active (grace
     period, failed renewal)? Each will be asked by the feed, search, the map, the seller dashboard and the admin.
   - This review fixed the ban rule existing twice (HTTP vs socket). Give each money rule exactly **one** SQL function
     (`boost_is_live`, `subscription_is_active`) like `post_is_listed`, and a parity test that runs every caller.
5. **Boosts change ranking on queries nobody has re-measured.**
   - §9 wasn't re-run this month; feed, search and map now carry stores, places, info cards and soon boost weights.
   - Re-run the Month 2 perf setup with Month 3 volumes **plus** boosted rows before boosts ship, set p95 budgets per
     endpoint, and keep it as a CI job.

**Smaller things to close in Month 4:**

- Decide the chat-cap question (§15) and the three unenforced retention promises (§8); add notification retention.
- Account deletion (Google Play requires it) and an admin path for legal holds.
- Throttle socket `typing`; cap connections per user.
- OTP length still duplicated in the app (`otp_verify_screen.dart:17`); `MailModule` still in `AppModule`.
- A device walkthrough of the Month 3 app (§10).
- Dependency audit in CI.

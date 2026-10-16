# ADR 064: Local information services — emergency contacts, blood donors, bazar prices

**Status:** Accepted (2026-10-15). Builds schema.md §10.1–§10.8 (tables from 0011) into services.

**Code:**

- **Database:** `infra/migrations/0060_local_info_services.sql`.
- **API** (`apps/api/src/info/`):
  - `EmergencyService` — `GET /info/emergency`, the area team's contact upkeep;
  - `BloodService` — donors, contacts, urgent requests; `BloodAlertsService` — the matcher and expiry
    (jobs `alert-blood-donors`, `expire-blood-requests` in the notifications worker);
  - `BazarBoardService` (the board, shared with the feed through `InfoReadModule`) and `BazarService`
    (fast entry, catalogue, sponsor);
  - `engagement/lead-gate.ts` — the lead dedupe and per-viewer cap, extracted from `ContactService`
    so blood contacts use the same rule.
- **Feed:** the bazar card gains arrows, the stale flag and the sponsor; a new `blood` card.
- **Mobile:** `lib/features/info/` — hub, emergency (Drift `EmergencyPageCache` + bundled
  `assets/emergency/national_hotlines.json`), blood (find, requests, my registration, who contacted
  me), bazar board and fast entry.
- **Web:** `/info` (emergency from the API, tenant-config fallback) and `/info/bazar`.
- **Admin:** `/local-info` — emergency contacts, the bazar entry/catalogue/sponsor, blood takedowns.
- **Tests:** `apps/api/test/local-info-services.db-spec.ts`, `apps/api/test/local-info.e2e-spec.ts`,
  `apps/api/src/info/bazar-trend.spec.ts`; mobile `test/features/info/info_test.dart`; web
  `lib/info/bazar.test.ts` and `apps/e2e/tests/web.spec.ts`; admin nav test.

## Context

0011 created the tables but nothing served them. Building on them showed gaps between the brief and
the schema, settled as follows:

- **No `info_posts` table.** The feed's "info cards" (ADR 035) are built in `FeedService`; they are
  extended, not replaced by a table.
- **National numbers are `national_hotlines`** (global), not global rows of `emergency_contacts`. The
  table was never seeded — the feed's emergency card was always empty. 0060 seeds 999, 16163, 16263,
  109, 1098, 333, 1090, 16430, 106 and the service types they need.
- **`bazar_commodities` is global; the brief wants a per-area catalogue.** New `tenant_bazar_items`
  picks commodities, unit and order per area. Without one, an area shows every active commodity —
  `bazar_catalogue()` is that one rule. The global catalogue (rice varieties, lentils, oils, onion,
  potato, vegetables, fish, meat, eggs…) now ships in the migration.
- **The donation gap is `blood_donation_interval_days`** (0003, Q19), already read by the
  `eligible_from` trigger. The brief's `blood_donation_gap_days` would be a second key for one rule,
  so none was added.

## Decision

### Emergency contacts — the screen that must never fail

- `GET /info/emergency` (public): national hotlines, then local contacts **within
  `emergency_contacts_radius_km` of the viewer from every area** (rule 10), plus the area's own contacts
  that have no point. Grouped by service type in the lookup's order, nearest first. `version` is a hash
  of the content; `refreshAfterSeconds` is `emergency_refresh_hours`.
- **Mobile** reads Drift first (`EmergencyPageCache`, the whole page per area), else the bundled
  national numbers plus the tenant config's local contacts, and only then refreshes. The app shell
  refreshes the copy in the background when it is due. Nothing on the path throws; a failed refresh
  keeps what is shown.
- **Reachable from anywhere:** `/info/emergency` is exempt from every redirect (no area yet, signed
  out, banned, terminated), and the splash failure screen links to it.
- One tap calls (`tel:`); a contact with a point has a map pin that opens the phone's map app, as
  chat's shared locations do — our own tiles can't be focused on a point yet.
- Staff and field agents add, edit, re-verify (`last_verified_at`) and remove the area's contacts.

### Blood donors

- **Opt in** (`PUT /blood/me`): group, approximate location (snapped to
  `blood_donor_location_grid_m` by trigger, never shown), last donation, contact window
  (`donor_contact_windows`), whether the number is shared, alerts on/off. The eligibility statement
  and the `blood_donor_listing` consent (`user_consents`, first registration) are required.
- **Pause instantly** (`is_available`); **a recorded donation** sets `last_donated_on`, and the
  trigger moves `eligible_from` — the donor is off every list until then. `blood_donor_listable()` is
  the one rule (available, past the gap, account and membership in good standing) used by the search,
  the contact path and the matcher.
- **Search** (`GET /blood/donors`, signed-in only): by group (optionally compatible groups,
  `blood_group_compatibility`) and distance from the viewer, across areas (`blood_donors_near`). The
  distance is rounded to the grid; no number, ever.
- **Contact** (`POST /blood/donors/:id/contact`): through `LeadGate` (dedupe + per-viewer cap) and
  `blood_donor_record_contact()`, which locks the donor row and refuses past
  `blood_donor_daily_contact_cap` in 24 hours (the donor's area). It writes `blood_donor_contacts`
  ("who contacted me", the donor reads it under RLS) and a `lead_events` row. A donor who shares the
  number: it is returned with a `tel:` link. One who doesn't: they get a push and decide (lead channel
  `donor_request`).

### Urgent requests

- `POST /blood/requests`: group, units, hospital and its point, needed-by (at most
  `blood_request_max_ahead_hours` ahead), urgency; at most `blood_request_max_open_per_user` open.
- **Alerts:** `blood_request_alert_donors()` (system only) picks compatible, listable donors with
  alerts on, within `blood_request_alert_radius_km` of the hospital, **inside their contact window in
  their area's local time** and under `blood_donor_alerts_per_day`; nearest first, at most
  `blood_request_alert_max_donors`. One `blood_request_alerts` row each, once per request
  (`alerted_at`). The API runs it right after creating; the `alert-blood-donors` job catches any
  request left unmatched. The `blood_request_nearby` push is urgent (not held by quiet hours) — the
  donor's own window, switch and cap already apply.
- **The requester's number** leaves only through `POST /blood/requests/:id/contact` (a lead, source
  `blood_request`). Lists and details never carry it.
- **Auto-close:** `expire-blood-requests` sets `expired` `blood_request_grace_hours` after needed-by.
  The requester closes it as fulfilled or cancelled.
- **Takedown:** `remove_blood_request()` (staff) sets `removed` and writes `moderation_actions`
  (new `blood_request_id` target) in one transaction (rule 13).
- **Feed:** a `blood` card with the number of open requests nearby and their groups — counts only, so
  it is safe in the shared, cached first page.

### Daily bazar prices

- **Fast entry** (`GET/PUT /bazar/entry`, staff and field agents): one sheet, every item with the
  previous day's figure prefilled, one save. `bazar_enter_prices()` publishes the area's consolidated
  figure (no market), corrects a second save in place, and accepts today back to
  `bazar_entry_backdate_days`. One writer per area and day (advisory lock).
- **Board** (`GET /bazar/board`, public): per item today, yesterday, the up/down/same arrow (mid-price
  compared in poisha, never floats) and `bazar_trend_days` of trend; `isStale` when nothing was entered
  today; the sponsor. Mobile and web show Bengali numerals.
- **Sponsor** (`bazar_board_sponsors`): one active slot per area, display only.

### Settings (0060)

`emergency_contacts_radius_km`, `emergency_contacts_max`, `emergency_refresh_hours`,
`blood_search_radius_km`, `blood_search_max_radius_km`, `blood_page_size_max`,
`blood_donor_daily_contact_cap`, `blood_donor_location_grid_m`, `blood_donor_alerts_per_day`,
`blood_request_alert_radius_km`, `blood_request_alert_max_donors`, `blood_request_grace_hours`,
`blood_request_max_ahead_hours`, `blood_request_max_open_per_user`, `blood_job_batch_size`,
`bazar_trend_days`, `bazar_entry_backdate_days`, `feed_blood_card_position`.

## Consequences

- **Radius readers bypass RLS by design.** `emergency_contacts_near`, `blood_donors_near`,
  `blood_requests_near` and `blood_requests_summary_near` are SECURITY DEFINER (like `feed_stores`).
  Each checks its caller (signed-in for anything personal) and returns no phone except public
  institutional numbers.
- **`ContactService` lost its private `countLead`** to `LeadGate`; behaviour is unchanged.
- **The feed cache key moved to `v4`** (new card shapes).
- **The dev seed** now upserts commodities by code (the migration ships them).
- **Not built:**
  - selling the sponsor slot (week 16);
  - in-app chat with a donor (the in-app ask is a notification and a "who contacted me" row);
  - per-market prices in the fast entry (the area's consolidated figure only);
  - focusing our own map on an emergency contact (the pin opens the phone's map app);
  - blood screens on the web (the page explains the service; the app has it).

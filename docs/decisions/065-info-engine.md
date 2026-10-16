# ADR 065: The info engine — outages, transport, notices, prayer times, lost & found, the government guide, farming, directories

**Status:** Accepted (2026-10-16). Builds on ADR 064 (local information services) and schema.md §10.15.

**Code:**

- **Database:** `infra/migrations/0061_info_services.sql`.
- **API** (`apps/api/src/info-engine/`): one card contract (`dto/info-card.schema.ts`, `info-cards.ts`), one scope
  (`InfoScope`: tenant, team/staff checks, origin, settings), one moderation path (`InfoModerationService` →
  `decide_info_item()`), one expiry job (`InfoJobsService`, `expire-info-items`, in the notifications worker), one
  stale rule (`info-engine.rules.ts`). Services: outages, notices, lost & found, transport, gov services, directory,
  prayer settings, the feed's info and prayer slots (`InfoFeedService`), and `InfoNotifier`.
- **Feed:** `{kind: 'info', card}` at `feed_info_card_position` (up to `feed_info_cards_max`) and `{kind: 'prayer'}` at
  `feed_prayer_card_position`.
- **Mobile:** `lib/features/info/` — `InfoCardTile` (every list and the feed), `InfoListScreen` (every type's list),
  outages (report sheet), notices (detail with the janaza/condolence template, new community notice), lost & found
  (list, detail with the tracked contact, report with photos), transport (next departures), gov guide (checklist,
  versions), directory, agri hub, prayer screen (`prayer/prayer_times.dart`), map pins.
- **Web:** `/info/{outages,notices,lost-found,transport,gov,directory,prayer,agri}` and their detail pages, the home
  page's info and prayer cards, `/info/bazar?board=agri`, `/api/info/lost-found/:id/contact`.
- **Admin:** `/local-info/{outages,transport,notices,gov,moderation}` (phone-first forms), the bazar entry's board
  switch, `/api/info/attachments` (a notice's PDF or photo).
- **Tests:** `apps/api/test/info-engine.db-spec.ts`, `apps/api/test/info-engine.e2e-spec.ts`,
  `src/info-engine/info-engine.rules.spec.ts`; web `lib/info/prayer.test.ts`, `lib/info/engine-format.test.ts`,
  `apps/e2e/tests/web.spec.ts`; admin `local-info/engine-form.test.ts`; mobile `test/features/info/prayer_test.dart`,
  `test/features/info/info_engine_test.dart`.

## Context

The brief says "on the info_posts engine". There is no `info_posts` table, and making one would mean moving the 0011
tables (`notices`, `lost_found_items`, `transport_routes`…) into a generic row with jsonb — losing their constraints
and RLS. So the engine is code and rules, not a table: every type keeps its own table and its own SECURITY DEFINER
reader, and they all speak one card.

## Decision

### One card, one list, one moderation path, one expiry

- **The card** (`InfoCard`): `type`, `id`, `tenantId`, `title{bn,en}`, `summary`, `badges` (codes the apps name),
  `startsAt`/`endsAt`/`updatedAt`, `isStale`, `distanceMeters`, `location`, `image`. Every list, the feed and the
  apps' tiles use it; a type adds only its detail.
- **Discovery is radius-based** (`info_search_radius_km` from the viewer, or the area's centre on the web). Area
  boundaries decide who keeps an item, never who sees it — except the government guide, which is the area's own
  board (the office's jurisdiction is the boundary).
- **Stale data**: transport, the gov guide and directories carry `info_stale_days_{transport,gov_service,directory}`;
  past it, "may be out of date" on every card and detail. "Checked today" (`verify`) renews it without an edit.
- **Moderation**: members' community notices (janaza and condolence included) and every member lost & found report
  wait in one queue; `decide_info_item()` changes the status and writes `moderation_actions` with the reason in the
  same transaction; the author is told (`info_item_decided`). Reports on live items land in the same queue;
  approving one keeps it (reports dismissed, the review recorded).
- **Expiry**: `expire_info_items()` ends outages, notices (`notice_{local,community,obituary}_expiry_days` when no end
  was given) and archives lost & found (`lost_found_expiry_days`), in batches, as the system.

### Per type

- **Outages**: the area team schedules (utility, locality or the whole area, window, reason). Members report "no
  power here"; a locality shows once `outage_report_min_reports` people agree within
  `outage_report_window_minutes` (nearest locality within `outage_report_locality_km`) — never who.
- **Transport**: routes with stops, departure times (days of the week, validity, class, fare), fares and the operator,
  kept by the team; `transport_next_departures()` answers "next from now" in the area's own time.
- **Notices**: local (union/pourashava, government, school, religious), community and advisory (weather/farming);
  validity window; PDF or image attachments (documents through a short-lived link,
  `notice_attachment_url_ttl_seconds`).
- **Lost & found**: people, pets, items; photos, last seen place and time, reward. The reporter's number only through
  the tracked contact (a lead, `LeadGate`), and they are told someone got in touch (`lost_found_contacted`).
- **Prayer times**: calculated on the device (Dart) and on the web server (TS) from coordinates with the PrayTimes
  formulas — no API. Method, Asr school, Hijri adjustment and sehri/iftar caution minutes are tenant settings; the
  Ramadan view is the month's sehri and iftar. Both implementations are checked against the same vectors.
- **Government guide**: name, office (on the map), hours, documents checklist, fees, steps, official links; every
  save is an append-only version; "last verified on".
- **Farming** (`agri_services_enabled`, per area): input prices are the bazar board's `agri` side (fertilizer, seed,
  pesticide groups), advisories are `weather_alert` notices, equipment rental is ordinary posts in the agriculture
  category.
- **Directories**: places by category (hospital/clinic/diagnostic, pharmacy with the 24-hour flag from its hours,
  schools/colleges/madrasas) — the places module and its map layer, not a new table.
- **The map**: the `info` layer adds open lost & found reports, government offices and outages on now (at their
  locality's centre); map kinds `lost_found`, `gov_offices`, `outages`, `education`.

## Consequences

- A new info type is a table + reader + a card mapper + a list screen configuration; the card, the moderation path,
  the expiry and the stale rule come with the engine.
- The feed's DTO imports only `info-card.schema.ts`: importing the full engine DTO made a cycle
  (feed → info-engine → engagement → feed) that left `PostDetailDto.similar` untyped.
- Phone numbers stay out of every card, map preview and list; only the contact endpoints reveal them, and they write
  a lead.

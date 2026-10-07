# ADR 051: Map-specific reporting and moderation

**Status:** Accepted (2026-10-07).

**Code:**

- Migration: `0046_place_reports_and_suggestions`
- API: `apps/api/src/places/place-moderation.{controller,service,repository}.ts`,
  `DuplicatesService.scoreReportedPair / fileReportedPair`, the `approved_edits` trust input
- Admin: `apps/admin/src/app/(dashboard)/moderation/places/` (the Places tab)
- Mobile: `apps/mobile/lib/features/place_feedback/` (report sheet, suggest screen), reached from a place's preview
  on the Map tab
- Tests: API `test/place-reports.db-spec.ts`, `test/place-reports.e2e-spec.ts`, `src/trust/trust-formula.spec.ts`;
  admin `moderation/places/reasons.test.ts`, `lib/nav/nav.test.ts`; mobile
  `test/features/place_feedback/place_feedback_test.dart`, `test/features/map/map_screen_test.dart`

## Context

Places come from agents and members (ADR 047) and go stale: a shop closes, moves, changes its number. The map needs
two member-facing paths, both moderated:

- telling us something is wrong (a report);
- telling us what is right (a suggested edit).

Moderators need one place to work through new places, claims, suggestions, duplicates and reports.

## Decision 1: reports reuse `reports`, through one SQL function

`reports` has had a `place_id` target since 0010. A place takes five reasons:

- `wrong_location`, `closed_permanently` and `inappropriate` (new in 0046);
- `duplicate` and `wrong_information` (existing).

`report_place()` is a SECURITY DEFINER function that runs as the reporter. In one transaction it:

- files the report. There is one open report per reporter per place (0010's unique index), and a repeat returns the
  open report;
- refuses the place's own claimed owner, who edits instead (AE201);
- writes a `place_reported` moderation_actions row;
- on `closed_permanently`, counts DISTINCT open closed reporters. At `place_closed_report_threshold` (tenant
  override; 0 = off) it sets `places.possibly_closed_at` and writes a system `flagged_possibly_closed` row with the
  reports as evidence. The place row is locked first, as in `report_post()`.

A flagged place stays on the map. The API exposes `possiblyClosed`, and a moderator decides. The reporter's answer
never says how many others reported or whether the place was flagged.

Only `report_place()` (checked as `current_user = ae_rls_bypass` in the places guard trigger) and staff may set
`possibly_closed_at`.

The same guard now also protects `merged_into_place_id`. This fixes a gap: a claimed owner could set it with a plain
UPDATE.

**Duplicate reports.** A duplicate report may name the other place. `place_pair_signals()` (SECURITY DEFINER; the
other place may be a neighbour tenant's) measures the pair, and the service scores it like any detected pair. A pair
below the "possible" score still counts as possible, because a person said so. It is filed in `duplicate_candidates`
with source `report`, so it shows in the duplicates queue.

The pair is checked before the report is filed. A place that is gone, or farther than `duplicate_report_radius_m`,
refuses the whole request (422), so no half-filed report is left behind.

## Decision 2: suggestions are their own table, applied through the edit path

`place_revisions` records applied changes only: it is append-only and written by triggers. A pending proposal is a
different thing, so it gets its own table, `place_edit_suggestions`.

- **Content:** `changes` holds a subset of `{location, phones, hours}`, enforced by a CHECK. `current_values` holds the
  place's values when the suggestion was made.
- **Status:** pending, approved, rejected or withdrawn. There is one pending suggestion per member per place.
- **RLS:** the suggester reads their own; staff of the tenant read and decide. Nobody inserts directly:
  `suggest_place_edit()` files the row and its `suggestion_submitted` row together.

The API validates and normalises a suggestion before filing it:

- phones are converted to E.164, up to `place_max_phones`;
- the location must stay in the place's tenant;
- hours obey `hours_ranges_per_day_max`;
- a field equal to what the place already shows is dropped, and if nothing is left the API answers 422.

**Approval.** In one transaction, approval applies the change through `PlacesRepository.update / replaceHours /
recordHoursRevision`, exactly like a moderator's own edit. So `place_revisions` records it, changed by the moderator.
The same transaction marks the suggestion approved and writes a `suggestion_approved` row. After commit:

- the suggester's trust score is recomputed;
- the suggester is notified (`place_edit_approved`).

**Rejection.** Rejection takes a reason (`suggestion_incorrect` or a takedown reason) and notifies the suggester.

## Decision 3: trust credit is an input, not a bonus

`computeTrust()` gains `approved_edits`. Each approved suggestion counts `trust_points_per_approved_edit`, capped at
`trust_max_approved_edit_points`. `TRUST_ALGORITHM_VERSION` becomes 2.

Because it is an input computed from the table, the credit always matches the decisions on record.
A good contributor rises past `place_contribution_trust_threshold` (ADR 047), and their own new places then go live
directly.

## Decision 4: moderator decisions on reports, per place

`POST /places/:id/reports/decision` takes one of these decisions:

| decision            | the place                     | open reports          | moderation_actions    |
| ------------------- | ----------------------------- | --------------------- | --------------------- |
| `dismiss`           | unchanged                     | all → dismissed       | `reports_dismissed`   |
| `resolved`          | unchanged (fixed elsewhere)   | all → actioned        | `reports_resolved`    |
| `confirm_closed`    | → `permanently_closed`        | all → actioned        | `closed_confirmed`    |
| `clear_closed_flag` | flag cleared                  | closed ones dismissed | `closed_flag_cleared` |
| `unpublish`         | → `rejected` (needs a reason) | all → actioned        | `unpublished`         |

Any decision clears the "possibly closed" flag. A decision with nothing to decide answers 409, except
`confirm_closed`, which a moderator may make on their own knowledge.

## Decision 5: the Places tab

The admin moderation section gains a Posts | Places switch. Either grant opens the section (`posts:approve` or
`places:approve`). A places-only moderator who opens `/moderation` is redirected to their tab.

The Places tab has five sub-tabs, each the API's own queue, loaded together so every sub-tab shows its count:

- **new places:** approve / reject;
- **claims:** approve / reject;
- **edit suggestions:** shown as "now → suggested", with how far a pin moves and the suggester's trust score;
  approve / reject;
- **duplicates:** merge / not a duplicate;
- **reports:** grouped per place, with the counts per reason, the reporters, the latest notes and a "possibly
  closed" badge; the decisions above.

## Follow-ups done in the same change

- **Picking the twin in the app.** With "listed twice", the report sheet lists the places around this one (from
  `/map/features`, nearest first, itself excluded), and the member picks which one is the same. "Not sure" still
  sends the report without a target.
- **The inbox.** The app now has a notification inbox (ADR 052) that words every type, the `place_*` ones included.
  Claim notifications now carry `placeName`.

## Settings added

| key                                  | default | scope        |
| ------------------------------------ | ------- | ------------ |
| `place_closed_report_threshold`      | 3       | tenant_admin |
| `place_suggestions_per_user_per_day` | 10      | platform     |
| `place_suggestion_note_max_length`   | 300     | platform     |
| `place_report_queue_notes_max`       | 3       | none         |
| `duplicate_report_radius_m`          | 1000    | platform     |
| `trust_points_per_approved_edit`     | 2       | platform     |
| `trust_max_approved_edit_points`     | 10      | platform     |

# ADR 066: Field agent mode — offline capture, exactly-once sync, review, anti-fraud, commission estimates

**Status:** Accepted (2026-10-16). Builds on 0012 (`field_agents`, `agent_visits`), the places module (ADR 047/048/051)
and schema.md §10.16.

**Code:**

- **Database:** `infra/migrations/0062_field_agent_mode.sql`.
- **API** (`apps/api/src/agents/`): `AgentSubmissionsService` (the sync endpoint), `AgentWorkService` (me, today,
  stats, the shop phone's OTP), `AgentsAdminService` (agents, tasks, a day's submissions, the commission report),
  `agent-fraud.ts` (the signals, pure).
- **Mobile** (`lib/features/agent/`): Drift outbox `AgentCaptures` / `AgentCapturePhotos` (schema 8), `AgentSync`, the
  capture screen, today's route, the queue, my stats; entry from the profile for the agent role.
- **Admin:** `/agents` (list, targets, rates), `/agents/[id]` (tasks), `/agents/submissions` (map and review list),
  `/agents/commissions`.
- **Tests:** `apps/api/test/agents.e2e-spec.ts`, `apps/api/test/agents.db-spec.ts`, `src/agents/agent-fraud.spec.ts`;
  mobile `test/features/agent/agent_sync_test.dart`, `agent_capture_test.dart`; admin nav test.

## Context

Agents put the first few hundred shops on the map, often where the network is poor, and they are paid per shop. So the
capture has to work offline all day, a sync must never make a shop twice, and the review must see what a cheat would
fake.

## Decision

### Offline capture and exactly-once sync

- **The id is made on the phone** (a v4 UUID, when the capture begins) and is `agent_submissions`' primary key.
- **Capture is local first.** A Drift row and the photos, compressed into the app's support directory (not a cache),
  are saved with no network. The save is refused when the GPS fix is worse than `agent_min_gps_accuracy_m`; the phone
  knows the value offline from the kept `GET /agent/me`. The fix and time at the shutter are recorded with the photo.
- **One sync at a time** (`AgentSync.syncAll`, joined by concurrent callers), oldest first, on reconnect, start,
  after a capture and on demand.
- **Photos.** Each photo goes presign → PUT → confirm-until-ready, and every finished step is saved. A resumed sync
  skips confirmed photos and confirms an uploaded one without sending it again. An interrupted PUT starts that photo over
  with a fresh URL — resume is per photo, not per byte; photos are ~150 KB.
- **Submit.** `POST /agent/submissions` with the UUID. The server takes an advisory lock on the id, looks for the row,
  and in the same transaction creates the place (`pending_review`, `agent_survey`), the visit and the submission row.
  A retried, lost-answer or concurrent upload gets the first answer and makes nothing.
- **Duplicates on sync.** The existing duplicate check runs before anything is written. A likely duplicate that people
  can see returns `needs_decision` with the candidates, and the agent answers:
  - "a different shop" — it is added;
  - "it's this one" — it is recorded as a verification of that shop (a visit, `field_verified_at`).
- **Errors.** No network, 5xx, 401, 408 and 429 are retried with backoff. Other errors are refused, keeping the server's
  reason (`outside_area`, `too_old`, `place_not_found`…); the agent can retry or discard.

### What a submission makes, and its review

- **A new shop** waits in the places review queue (approve/reject + `moderation_actions`). Agents' ordinary place
  contributions still go live; agent-mode captures are paid, so a person approves them.
- **An update** is an edit suggestion (phones, hours) in the suggestions queue.
- **A verification** is a visit.
- **The shop must be in the agent's own area.** Boundaries decide who earns.
- **Review status is derived, never stored:** `agent_submission_outcomes()` reads the place (published = approved,
  rejected with its reason, merged = duplicate) or the suggestion. The agent's stats, the admin's numbers and the
  commission report all use it.

### Anti-fraud (flags for the reviewer; never an automatic rejection)

All thresholds below are settings.

| Flag                 | What triggers it                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `gps_photo_mismatch` | The shutter's fix is farther than `agent_fraud_photo_fix_max_m` from the save's, older than `agent_fraud_photo_age_max_minutes`, or missing. |
| `impossible_travel`  | Faster than `agent_fraud_max_speed_kmh` from the nearest-in-time capture on either side (the queue syncs out of order).                      |
| `rapid_fire`         | Within `agent_fraud_min_seconds_between` of the previous capture.                                                                            |
| `duplicate_photo`    | The same checksum, or the same thumbhash (re-encoded), as another submission in the area within `agent_fraud_photo_lookback_days`.           |
| `phone_otp_failed`   | The shop's phone failed its OTP. The check runs online, before or after the sync, keyed by the submission id.                                |

Reading the photo's own EXIF location would need a new parser dependency (the media pipeline strips EXIF), so the app
records the fix at the shutter instead.

### Commission

- The estimate is the approved count × the rate: the agent's `commission_rate`, or `agent_commission_per_shop`
  (verifications and updates have their own settings, default 0).
- Money is summed in poisha.
- It is a calculation only. Payouts are manual; payments are Months 4–5, and `agent_commissions` (0012) is untouched.

## Consequences

- A capture is proof: the trigger keeps it as captured, and only the system adds flags.
- The places module's rules (names, phones, category, hours, duplicates, review) are reused, not re-implemented:
  PlacesService exposes `checkNames` / `normalizePhones` / `geoAreaAt`, and the suggestion helpers are exported.
- The `agent_shop_phone` OTP purpose has its own SMS text, telling the owner the code only confirms the number.

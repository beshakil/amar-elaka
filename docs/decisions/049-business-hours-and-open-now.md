# ADR 049: Business hours and "open now" — one SQL implementation for every surface

**Status:** Accepted (2026-10-07). Replaces the open-now logic inside `map_features()` (ADR 045, migrations 0039–0041).

**Code:**

- Migration: `0044_business_hours_open_now`
- API: `apps/api/src/hours/` (open-state type, store hours, special days, "closed today"); open state wired into
  `places`, `feed`, `search` and `map`
- Tests: `test/hours.db-spec.ts`, `test/hours.e2e-spec.ts`, `src/search/query/search.service.spec.ts`

## Context

Before this change:

- Places had a weekly schedule (`place_hours`, 0005); stores had none.
- The map computed open-now itself, inline in `map_features()`, with `'Asia/Dhaka'` hard-coded.
- There were no holidays and no way for an owner to say "closed today".
- Feed, search and detail views had no open state at all.

## Decision 1: the model

- **Weekly:** `place_hours` and a new `store_hours`, the same shape. A day may have any number of ranges (split shifts:
  closed for Jummah, closed in the afternoon). `closes_next_day` marks a range that ends after midnight.
- **Store without hours:** it uses its place's schedule; the place is its map pin (ADR 047).
- **Special days (`hours_exceptions`):** by local date, for a place or a store.
  - A date with any special day ignores the weekly schedule.
  - A day is either closed (a holiday, with an optional note such as "ঈদের ছুটি") or has its own ranges; a closed row
    wins.
- **"Closed today" (`closed_until` on places and stores):** the owner's toggle. The API sets it to the next midnight
  in the tenant's zone, so it expires by itself and an owner can't forget to turn it off.
- **Timezone:** `tenants.timezone` is a column on every tenant, validated against `pg_timezone_names` by a trigger.
  The open state is always computed in the owning tenant's zone. Nothing assumes Asia/Dhaka; a test uses an
  Asia/Kolkata tenant to prove it.

## Decision 2: `is_open_at(entity_type, id, at)` is the only implementation

A STABLE SECURITY DEFINER SQL function returns `open_state (state, changes_at)`.

| state         | meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `unknown`     | no hours at all — **never "closed" for lack of data**                                   |
| `closed`      | temporarily/permanently closed, "closed today", a closed special day, or between ranges |
| `opens_soon`  | closed, opening within `hours_opens_soon_minutes` (30)                                  |
| `open`        | inside a range                                                                          |
| `closes_soon` | open, closing within `hours_closes_soon_minutes` (30)                                   |

How it works:

- **`changes_at`** is the next opening or closing within `hours_lookahead_days` (8). It feeds labels like
  "৯:৩০-এ খুলবে".
- **Intervals:** `hours_intervals()` builds them per local date, from yesterday so overnight ranges are covered. Ranges
  that touch or overlap merge into one: 22:00–24:00 plus 00:00–02:00 is open until 02:00, not "closes soon" at
  midnight.
- **"Closed today"** moves the question to `closed_until`: the place reopens then if a range is running, otherwise at
  the next range.
- **Emergency contacts** are open when 24-hour, otherwise unknown.

Everything else only calls it:

- `open_states()` for batches;
- `open_ids_near()` for search's filter;
- `feed_stores` / `feed_landmarks` (`p_open_only`);
- `map_features()`;
- the store and landmark cards, place detail, search hits and `GET /stores/:id/hours`.

## Decision 3: `open_now` per surface

`open_now=true` keeps entities whose state is `open` or `closes_soon`. Unknown entities are not kept; they aren't
known to be open.

- **Map:** stores, places, landmarks and info by `is_open_at`; bus stops stay ("always open"). Posts are left out and
  named in `open_now_skipped`, as before. Features also carry `open_state` and `open_changes_at`.
- **Feed:** store cards (via `feed_stores`) and landmark cards. Post cards are listings, not venues, so they stay.
  Every store and landmark card carries `openState`.
- **Search:** `type=stores|places` only; `type=posts` with `open_now` is a 400. Hits carry `openState`.
  - On Meilisearch, the open ids within the radius (`open_ids_near`, up to `search_max_total_hits`) become an `id IN`
    filter, so relevance, sort and paging stay the engine's.
  - Opening hours change by the minute, so they are never indexed.
  - The database fallback filters with `is_open_at` directly.

## Decision 4: the API

- **Place weekly:** `PATCH /places/:id` `businessHours` (versioned, ADR 047), now limited to
  `hours_ranges_per_day_max` (4) ranges per day.
- **Store weekly:** `PUT /stores/:id/hours` (its managers, or staff, by RLS); `GET /stores/:id/hours` is public.
- **Special days:** `PUT /places/:id/special-days` and `PUT /stores/:id/special-days`.
  - The request replaces the upcoming list (today on); past days stay.
  - At most `hours_special_days_max` (60); dates must be real, unique and not in the past.
- **"Closed today":** `POST /places/:id/closed-today` (the claimed owner or staff, not a field agent) and
  `POST /stores/:id/closed-today`, with `{closed: true|false}`.
- **Place detail:** `openState`, `specialDays` and `closedUntil`.

## Also in this change

- The feed's "today's bazar prices" now uses the tenant's zone instead of `'Asia/Dhaka'`.
- Platform-wide daily counters still use Asia/Dhaka on purpose: the geo-provider budget day (ADR 044) and the
  audit-log partitions (0012). They belong to no single tenant.

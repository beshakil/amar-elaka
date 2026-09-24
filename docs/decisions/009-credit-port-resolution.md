# ADR 009: Where closed-tenant credits go: distance cap, then relationship, never strangers

**Status:** Accepted (Q39); pool-restore behaviour confirmed (CONFIRM 2)
**Date:** 2026-09-17
**Schema:** [§13.32](../specs/schema.md), [§6.22 `credit_closure_dispositions`](../specs/schema.md), [§6.21 `platform_credit_pool`](../specs/schema.md), [§2.11 `tenant_members.last_active_at`](../specs/schema.md), settings `credit_port_max_km`, `credit_port_activity_lookback_days`

## Context

Q32 said to port unused credits to "the nearest active tenant, or where the user is most active", without
an order or a limit. With no cap, some tenant is always "nearest", so credits would be moved hundreds of
kilometres to places the user has never used.

## Decision

When tenant A closes, for each user with a balance:

1. **Candidates** = active tenants whose centroid is within `credit_port_max_km` (default 60) of A's centroid.
2. Among candidates, prefer tenants where the user has a `tenant_members` row with activity in the last
   `credit_port_activity_lookback_days` (default 180). If several match, pick the **most recently active**.
3. If none match, pick the **nearest** candidate, but **only if the user already has a membership there**.
   Never create a membership just to move money.
4. Otherwise **park** the balance in `platform_credit_pool` (no expiry).
5. **Notify the user on every port and every park, in-app and by SMS**, stating the amount (credits and
   purchased value) and the destination. The SMS is transactional and ignores notification preferences.

## Reasoning

- **Never port to a tenant the user has no relationship with:** that's how a balance ends up somewhere
  the user will never look, which is functionally the same as zeroing it.
- **Distance first:** credits are only useful where the user can buy locally; a cap keeps "nearest" meaningful.
- **Recency beats proximity:** a tenant the user actually uses is the best predictor they'll spend the credits.
- **Parking is safe:** the pool never expires, and a cash refund of purchased credits stays available during the refund window.

## Consequences

- `tenant_members.last_active_at` is needed (touched at most once per Dhaka day).
- **Adjusted from Q32, confirmed (CONFIRM 2):** when a new partner takes a closed area, parked users are **notified**
  only; the balance returns when the user becomes active there (or in any active tenant), because step 3 forbids moving
  credits into a tenant the user has no relationship with.
- Distances are centroid-to-centroid (`geo_areas.centroid`), recorded on the disposition for audit.

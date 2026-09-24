# ADR 013: Two-phase platform share rate (provisional at sale, final at month close)

**Status:** Accepted (Q42); precision decided (Q50)
**Date:** 2026-09-17
**Schema:** [§6.2 `credit_transactions`](../specs/schema.md), [§7.12 `platform_share_rate_backfills`](../specs/schema.md), [§13.36](../specs/schema.md)

## Context

ADR 008 needs "the platform share rate in force when the credits were sold". Revenue share uses **marginal slabs**
on the tenant's monthly total, so no single transaction has "the" rate. The platform actually receives
`effective_rate × month gross`, and that's only known when the month closes.

## Decision

1. **At purchase:** `credit_transactions.platform_share_rate_provisional numeric(5,4)` = the marginal slab rate in
   force at that instant, computed from the tenant's month-to-date net gross. It's **for immediate display only**.
2. **At month close:** a monthly job, `backfill_platform_share_rates(period)`, computes each tenant's **blended effective
   rate** for the month (credits-stream platform share ÷ credits-stream revenue basis) and writes it to
   `credit_transactions.platform_share_rate_final` (`numeric(9,8)`) and the allocated `platform_share_bdt_final` on **every** purchase of that month. It's a one-time UPDATE from NULL,
   the only permitted update on this append-only table.
3. **All liability, settlement and porting maths use `_final`.** They fall back to `_provisional` only while the month
   is still open, and are recomputed once it closes:
   - `credit_liability_settlements` rows are trued up (`trued_up_at`, `true_up_delta_bdt`, adjustment journal);
   - `tenant_final_settlement` can't be approved while any batch rate is provisional.
4. Lots don't copy rates. They carry `purchase_transaction_id`, so one back-fill updates the rate for credits wherever
   they now sit (including ported lots in other tenants).

## Required test

After back-fill, for a closed month, the per-transaction platform share (`platform_share_bdt_final`, allocated as below)
sums **exactly** to the platform share recorded in the tenant's revenue ledger (`settlement_ledger_entries`, credits
stream) for that month, and `SUM(credit_value × platform_share_rate_final)` matches it within ৳0.01.

## Precision (Q50, decided): largest-remainder allocation

A rounded rate times each transaction, rounded to the poisha, can't sum exactly to the ledger. That's arithmetic, not
a bug. The standard accounting fix, the same one used to split tax across invoice lines, is to **allocate the total**
rather than recompute it:

1. `platform_share_rate_final` is stored as `numeric(9,8)`, so rate rounding is negligible.
2. At back-fill, each purchase's unrounded share `credit_value × blended_rate_exact` is floored to the poisha; the
   leftover poisha (ledger total − sum of floors) go one each to the purchases with the largest fractional remainders
   (ties by `id`). The result is stored in `credit_transactions.platform_share_bdt_final`.
3. `SUM(platform_share_bdt_final)` for the month equals the ledger **exactly**, and no row is off by a full poisha.
   A CHECK on `platform_share_rate_backfills` enforces the equality, and no residual adjustment exists.

**Test:** for a closed month, `SUM(platform_share_bdt_final)` = the credits-stream platform share in the ledger,
exactly. `SUM(credit_value × platform_share_rate_final)` is within ৳0.01. The fixture includes 3 × ৳33.33 at a
blended rate of 1/3, where naive rounding would miss by a poisha.

## Consequences

- Month close gains an ordering dependency: settle the period → back-fill rates → true-ups → approve final settlements.
- The job is idempotent (unique per tenant-period); re-running changes nothing.

# ADR 011: Compensate stopped boosts with time, not money

**Status:** Accepted (Q41)
**Date:** 2026-09-17
**Schema:** [§6.7 `boosts.stop_reason_code`](../specs/schema.md), [§6.24 `boost_vouchers`](../specs/schema.md), [§13.35](../specs/schema.md), settings `boost_voucher_validity_days`, `boost_slots_per_category`

## Context

A seller buys a 7-day boost and the item sells on day 2. The post is marked `sold`, leaves the feed, and
the boost keeps occupying a scarce slot for five more days, wasted for everyone. Something must happen to
the boost and to the value the seller paid.

## Decision

When a post moves to `sold`, or is deleted or hidden by its owner, while a boost is active:

1. The boost **stops immediately** (`status = stopped`, `stop_reason_code`) and frees its slot. A sold post must
   not hold a scarce slot.
2. **No credit refund.**
3. A `boost_vouchers` row is issued for **`LEAST(CEIL(remaining_hours / 24.0), package_days − 1)`** days (Q47), for the same boost package, usable on **any
   future post by the same user in the same tenant**, valid for `boost_voucher_validity_days` (default 30).
   Redeeming creates a boost with `cost_credits = 0`.
4. **Exception:** no voucher when the post was taken down by a moderator (`removed`, `moderator_removed`,
   `legal_hold`), deleted as spam, or the tenant closed. That value is forfeited.

## Reasoning

- **A refund invites abuse:** buy 7 days, "sell" on day 1, take the money back, repeat. Boosts become free trials.
- **Forfeiting the whole boost punishes the behaviour we want:** marking items sold honestly. If sellers learn that
  marking sold burns their boost, they stop marking sold, and **if nobody marks anything sold, our price data is
  worthless.** We must not tax honesty.
- **A voucher keeps the value inside the platform** (no cash leaves) and keeps sellers truthful: the fair outcome
  for the honest seller, and useless to the abuser.
- **Moderator takedowns forfeit** because rewarding a policy violation with a voucher would subsidise it.

## Consequences and open points

- Slot capacity is the setting `boost_slots_per_category`; a stopped boost stops counting immediately.
- Owner **hide** counts as "removed by the owner" and earns a voucher. Hiding and unhiding doesn't restart
  the stopped boost; the voucher is the compensation.
- **Rounding (Q47, decided):** round **up**, because it favours the honest seller and costs the platform nothing in cash
  (a voucher is inventory, not money). But cap at `package_days − 1`, so the package always consumes at least one day.
  That cap is what stops "boost, mark sold an hour later, get the whole thing back". If the result is < 1, no voucher is
  issued (so a 1-day package never yields one).
- A voucher is redeemed in full on one post (no partial use), which keeps the model simple.

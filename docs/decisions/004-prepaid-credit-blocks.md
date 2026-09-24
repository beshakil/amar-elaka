# ADR 004: Prepaid credit blocks for partners

**Status:** Proposed. Flagged for decision, **not applied** to the schema.
**Date:** 2026-09-17
**Related:** [schema §13.32](../specs/schema.md) (credits as liability, closure handling),
§6.18–6.22, §7.11 `tenant_final_settlement`, open questions Q37 and Q38

## Context

Credits that users buy are a **liability** until they're spent. Under the current model:

- The user pays through a gateway, and the partner receives its revenue share on that payment (cash basis).
- When a tenant closes, unspent purchased credits must be ported, parked in `platform_credit_pool`,
  or refunded (§13.32). The platform bears that obligation.
- To cover it, the **full** outstanding liability is deducted from the departing partner's final
  settlement. If the settlement is too small, the partner owes a **shortfall** that we have to collect
  from someone who is leaving. This is the weakest point: collection risk sits exactly where the
  relationship ends.

## Proposal

Make a **prepaid credit-block model mandatory**:

1. A partner buys **credit blocks** from the platform up front at a wholesale rate
   (e.g. 10,000 credits for ৳X), paid in money before those credits exist.
2. A partner can only issue credits to users, sold **or** given as bonus, **by drawing from blocks it
   has already bought**. A tenant with an empty block balance can't sell or grant credits.
3. The user's retail purchase price minus the block's wholesale cost is the partner's margin,
   replacing (or complementing) the revenue share for the credits stream.

## Why this largely pre-solves closure

- The money backing every issued credit **is already with the platform** (the block purchase), so a
  closure shortfall largely disappears: the platform already holds cash for the liability it must honour.
- Porting, pooling and refunds (§13.32) stay as designed, but they're funded rather than
  receivable from a departing partner.
- `tenant_final_settlement` becomes a small reconciliation of unsold block credits
  (refund or forfeit per contract) instead of a debt-collection step.
- Bonus credits stop being free for partners to create, which removes an incentive to inflate
  bonus balances that later have to be ported.

## Costs and trade-offs

- **Partner cash flow:** partners pre-fund inventory. New or small partners may need starter blocks
  or credit terms, which reintroduces some receivable risk in a controlled form.
- **Pricing design:** wholesale/retail pricing replaces or changes the revenue-share slabs for the
  credits stream (§7.4–7.6); the settlement ledger needs block purchase and consumption journals.
- **Unsold block inventory at closure** needs a contractual rule (refund at cost, credit to a new
  tenant, or forfeit).
- **Accounting treatment** of block sales for the platform (deferred revenue vs partner deposit)
  needs an accountant's view (see Q10).

## Schema impact (if accepted, later)

Not designed yet. It would likely add:

- `partner_credit_blocks`: block purchase, wholesale price, credits bought/remaining, payment.
- A block allocation link on `credit_lots` (which block funded each issued lot).
- A per-tenant check that credits can only be issued while the partner's available block balance
  covers them (enforced under lock in `credit_apply()`).

Existing tables (`credit_lots`, `tenant_credit_liability`, `credit_closure_dispositions`,
`platform_credit_pool`, `tenant_final_settlement`) stay; their numbers become funded rather than owed.

## Decision needed

1. Adopt mandatory prepaid blocks: yes / no / only for new partners.
2. Does the credits stream keep revenue share, switch to wholesale margin, or both?
3. Contract rule for unsold block credits at closure.

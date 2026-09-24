# ADR 008: Departing partners return only their share, per batch; transfers hand it to the incoming partner

**Status:** Accepted. Q38, extended by **Q43** (transfers) and **Q42** (rates, see ADR 013)
**Date:** 2026-09-17
**Schema:** [§7.11 `tenant_final_settlement`](../specs/schema.md), [§6.18 `credit_lots`](../specs/schema.md), [§2.13 `tenant_transfers`](../specs/schema.md), [§13.33](../specs/schema.md)

## Context

Q32 deducted the **full** unspent-credit liability from a departing partner. But the partner only ever received
their revenue share of those payments; charging 100% makes them repay money the platform kept. And on a
**transfer** (same tenant, new partner), the question was who funds the incoming partner for credits the outgoing
partner already sold.

## Decision

### Termination (Q38)

1. Deduct `Σ per batch round(value_remaining_bdt × (1 − platform_share_rate_final), 2)` over purchased lots **sold
   under this partner** (`credit_lots.sold_under_partner_id`). Bonus lots and lots sold under other partners contribute 0.
2. The rate is the batch's **sale-month final rate** (ADR 013), never today's rate. A final settlement can't be
   approved while any batch's sale month is still open.
3. The platform keeps its share (`platform_share_retained_bdt`); nothing is moved or given back (ADR 007).
4. The deduction funds the closure reserve that pays spending partners (ADR 007).
5. `liability_calculation` stores the per-batch breakdown (lot, sale date, value, rate, whether final, deduction).
   The partner will ask.
6. Negative `net_payable` is a **receivable** (`from_partner` payout), never a silent write-off; a write-off is an
   explicit approved status with a reason.

### Transfer (Q43): nobody pays the platform share; it's already paid

In a transfer the `tenant_id` doesn't change, so **wallets don't move**; only the partner behind the tenant changes.

1. The outgoing partner's final settlement is reduced by `outstanding_liability × (1 − platform_share_rate_final)`
   (per batch, as above).
2. That **exact amount** is credited to the incoming partner as an opening liability fund:
   `tenant_final_settlement.liability_handover_amount` (= `tenant_transfers.credit_liability_amount`).
3. **The platform neither pays nor recovers anything; it keeps the share it earned at sale.**
4. The incoming partner earns the revenue when those credits are spent, `value × (1 − rate_final)`, funded by the
   handover fund (`credit_liability_settlements` rows of kind `partner_transfer`, no floor, no subsidy).
5. If the outgoing partner's settlement doesn't cover it, the shortfall is a **receivable from the outgoing partner**
   **and** the platform fronts the handover to the incoming partner, recorded as `platform_fronted_amount`, so it's
   visible and chaseable.

## Reasoning

- **Each party returns exactly what it received.** It's defensible, and verifiable from the batch breakdown.
- **Sale-month final rates:** the platform actually received the blended monthly rate, not a marginal one (ADR 013).
- **Transfers stay platform-neutral:** the share was earned at sale; a partner change is a business event between
  partners, not a platform revenue event.
- **Fronting:** the incoming partner mustn't start by serving credits unfunded because the outgoing partner defaulted.
  The platform carries that risk as an explicit receivable instead of hiding it.

## Consequences

- `credit_lots` carries `purchase_transaction_id` (rate source) and `sold_under_partner_id` (which partner earned the sale).
- Finance works a list of open receivables and fronted handovers (`tenant_final_settlement` indexes).

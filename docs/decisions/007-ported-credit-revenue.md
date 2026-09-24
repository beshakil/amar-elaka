# ADR 007: The platform takes its cut once; spending partners are paid the returned value

**Status:** Accepted. Q37 as **corrected by Q48** (this version replaces the earlier "B receives 100%" rule)
**Date:** 2026-09-17
**Schema:** [§6.23 `credit_liability_settlements`](../specs/schema.md), [§7.8 `settlements.ported_credit_revenue`](../specs/schema.md), [§13.33](../specs/schema.md), setting `continuity_subsidy_max_bdt_per_month`
**Related:** ADR 008 (what the closing partner returns), ADR 013 (which rate is "the" rate)

## Context

When tenant A closes, users' unspent credits are ported to tenant B (ADR 009). When the user spends them
in B, B's partner does the work, but the money was paid in A and shared between A's partner and the platform.

The first version of this ADR paid B **100%** of the credit value. Combined with A's partner returning only
their share, the platform ended up funding its own cut back out: **platform net zero**. That outcome was wrong.

## Decision

**Rule: the platform takes its share exactly once, at the moment of sale. It is never given back and never taken twice.**

On spend of ported credits in tenant B:

```
b_payout_rate = GREATEST(
    1 - platform_share_rate_final(at original sale in A),   -- term 1: what A's partner returned
    1 - b_current_effective_rate                            -- term 2: floor, B's own net rate
)
tenant B is credited  credit_value × b_payout_rate
```

- **Term 1, the normal case.** A's partner returned `(1 − rate_A)` at closure (ADR 008), and B receives exactly
  that. The closure reserve funds it in full. The platform is flat on the transfer and keeps the share it earned in A.
- **Term 2, the floor.** B is never paid less than it would net on its own sale of the same credits. It binds only
  when A's sale rate was **higher** than B's current effective rate.
- **When the floor binds**, the platform funds the difference and records it as **`continuity_subsidy_bdt`** on
  `credit_liability_settlements`. It's visible, and **capped at two levels** (Q49):
  - `continuity_subsidy_max_bdt_per_month` per receiving tenant (default ৳5,000), so one upazila can't absorb the
    whole budget;
  - `continuity_subsidy_platform_max_bdt_per_month` platform-wide (default ৳50,000), so total exposure is bounded.

  When either cap is hit, the payout falls back to term 1, `subsidy_capped = true`, and finance is alerted.
  The defaults are starting values sized for upazila-scale partner revenue, and can be changed without a deploy.

- **Ported credits stay excluded from B's revenue-share slab base**, because the platform's cut was already taken in A.
  Counting them would take a second cut and push B into a higher tier using money B never sold.
- Every spend writes a `credit_liability_settlements` row (rates used, whether each was final, payout, reserve-funded
  part, subsidy), so every movement is traceable and trued up when provisional rates become final (ADR 013).

## Worked example 1: 5% sale rate, floor not binding

| Step                                                                      | User | A's partner | Platform            | Reserve | B's partner |
| ------------------------------------------------------------------------- | ---- | ----------- | ------------------- | ------- | ----------- |
| User buys 100 credits in A for ৳100 at 5%                                 | −100 | +95         | **+5**              |         |             |
| A closes; A's partner returns its share `100 × (1 − 0.05)`                |      | −95         |                     | +95     |             |
| User spends all 100 credits in B (B's rate ≥ 5%) → `b_payout_rate = 0.95` |      |             |                     | −95     | +95         |
| **Net**                                                                   |      | **0**       | **+5, earned once** | 0       | **+95**     |

The platform's +৳5 is **not zero**. It's the share earned at sale, taken once and kept.

## Worked example 2: floor binding

A sold at **30%**; B's current effective rate is **10%**.

| Step                                                      | A's partner | Platform                     | Reserve | B's partner |
| --------------------------------------------------------- | ----------- | ---------------------------- | ------- | ----------- |
| Sale in A for ৳100                                        | +70         | +30                          |         |             |
| A closes, returns `100 × 0.70`                            | −70         |                              | +70     |             |
| Spend in B: `GREATEST(0.70, 0.90) = 0.90` → B is paid ৳90 |             | **−20 (continuity subsidy)** | −70     | +90         |
| **Net**                                                   | 0           | **+10**                      | 0       | +90         |

B isn't penalised because the credits were sold somewhere with a higher rate; the platform bears the gap,
visibly and within a monthly cap.

## Reasoning

- **Once and only once** is the simplest rule a partner can verify, and it matches how money actually flowed.
- **Term 1** makes porting cost-neutral for the platform in the common case.
- **Term 2** exists because B should never be worse off serving a ported user than serving its own customer; otherwise
  B's partner has an incentive to discourage ported users.
- **A capped, alerted subsidy** keeps that fairness from becoming an open-ended platform cost.

## Consequences

- Settlement statements show `ported_credit_revenue` (payouts) as a separate, non-slab line.
- Finance reviews `continuity_subsidy` monthly and on cap alerts.
- **Refunds are the one exception** to "never given back": a cash refund reverses the sale, so the platform returns its
  share (ADR 014, Q51).

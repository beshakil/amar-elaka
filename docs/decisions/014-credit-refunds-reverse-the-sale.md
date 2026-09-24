# ADR 014: A cash refund reverses the sale: full price, original payment method

**Status:** Accepted (Q51)
**Date:** 2026-09-17
**Schema:** [§7.3 `refunds`](../specs/schema.md), [§13.32](../specs/schema.md), [§13.33](../specs/schema.md), settings `credit_refund_window_days`, `credit_refund_sla_days`, `refund_manual_verification_threshold_bdt`
**Related:** ADR 007, ADR 008

## Context

When a tenant closes, users may take a cash refund of unspent **purchased** credits at the original price (Q32).
But ADR 007 says the platform takes its share once and never gives it back, and after closure the reserve only
holds the partner portion (`value × (1 − rate)`, e.g. ৳95 of a ৳100 purchase). Something has to cover the gap.

## Decision

1. **A refund is a reversal of the sale, not a payout from a sale that happened.** No sale means no share was
   earned, so the platform returns its share. This is the **only** exception to "taken once, never given back".
2. **The customer gets the full original price** of the unspent purchased credits:
   - partner portion `value × (1 − platform_share_rate_final)` from the closure reserve (`reserve_funded_bdt`);
   - platform portion `value × platform_share_rate_final` from platform revenue (`platform_share_returned_bdt`).
     Bonus, referral and promo credits are never refunded.
3. **Back through the original payment method.** Refunds go through the provider's refund on the original bKash,
   Nagad or card payment.
   - Only if that can't work (wallet closed, number recycled to someone else, provider refund window passed) does the
     refund go as a `verified_manual_payout`.
   - A manual payout needs an OTP on the account's **current** phone, and staff verification at or above
     `refund_manual_verification_threshold_bdt` (default ৳2,000).
4. **Gateway fees are never deducted from the customer.** MFS and card providers typically don't return the original
   merchant fee on a refund; the platform absorbs it (`gateway_fee_absorbed_bdt`).
5. **Service level:** `due_by = approved_at + credit_refund_sla_days` (default 10 days); breaches alert finance.

## Reasoning (Bangladesh context)

- **Consumer expectation and regulation.** Bangladeshi consumers expect a full refund of what they paid, not a
  deduction for the platform's commission. Consumer-protection enforcement (the Consumer Rights Protection Act 2009,
  via DNCRP) and the Digital Commerce Operation Guidelines 2021 both point toward refunds returned in full, promptly,
  to the payment method the customer used. **The exact SLA in days must be confirmed with legal counsel.** It's a
  setting, so aligning it is a data change, not a code change.
- **MFS reality.** Most payments are bKash or Nagad, which support merchant refunds to the original wallet, the safest
  and most traceable route. SIM recycling is common, so paying a refund to "the number on file" without re-verifying
  could send money to a stranger; hence OTP on the current account phone, and staff checks for larger amounts.
- **Fees.** Deducting the MDR from a refund would look like a hidden charge and invite complaints; the cost is small
  and predictable for the platform.
- **Consistency with ADR 007/008:** the partner returns exactly what they received (reserve), and the platform returns
  exactly what it received (its share). Nobody profits from a sale that was reversed.

## Consequences

- Refunds post a balanced journal: reserve and platform revenue down, gateway fee absorbed, customer refund payable up.
- Finance watches `due_by` breaches and manual-payout volumes (a spike can indicate fraud around recycled numbers).
- Tests (§15.3 I.4): full-price refund split correctly, fee absorbed, original method first, manual payout blocked
  without OTP / staff verification, bonus credits excluded, window enforced.

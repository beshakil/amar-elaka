# ADR 017: Pricing, revenue share, VAT, refunds authority, agents and cash

**Status:** Accepted (Q7, Q8, Q9, Q10, Q11, Q12, Q20). **VAT rates, the Mushak form and withholding applicability must be confirmed by a Bangladeshi VAT accountant before the payments phase.**
**Date:** 2026-09-17
**Schema:** [§6 commerce](../specs/schema.md), [§7.1 `payments`](../specs/schema.md), [§7.3 `refunds`](../specs/schema.md), [§7.4 `revenue_share_schemes`](../specs/schema.md), [§7.10 `payouts`](../specs/schema.md), [§2.17 `platform_counters`](../specs/schema.md), [§2.18 `vat_rates`](../specs/schema.md), [§11.10 `agent_cash_remittances`](../specs/schema.md), [§3.3 `categories`](../specs/schema.md)

## Decisions

### Q7: partners set prices within platform bounds

Credit packages, boosts, subscription plans and ad slots each carry platform-set min/max bounds; tenant admins price within
them (trigger-enforced). Purchasing power differs a lot between a rural upazila and a Dhaka metro thana, so partners need
room to price locally. Bounds stop a race to the bottom between neighbouring tenants, and stop gouging.

### Q8: partners pay their own field agents

Agents are local hires managed by the partner. `agent_commissions` records what's owed for transparency, but payment is
between partner and agent, outside the platform settlement ledger. The platform isn't the agents' employer.

### Q9: cash through agents is in scope, with controls

Many rural shopkeepers and users still prefer cash, so excluding it would exclude them. Controls reflect known Bangladeshi
field-collection risks:

- a per-agent `cash_limit`, and an alert when cash is held past `agent_cash_max_hold_hours`;
- an SMS receipt to the payer for every collection, so the payer can confirm what the agent recorded;
- `agent_cash_remittances` link every remitted payment; amounts must match, and an agent can't confirm their own remittance;
- bKash, Nagad or bank deposit remittance preferred (provider reference, unique per remittance) over physical handover;
- partner-held cash nets against payouts via `settlements.cash_held_by_partner`.

### Q10: the platform is the seller of record

Every payment is collected through the platform's gateways, so the platform issues the tax invoice:

- invoice numbers are **gapless per BIN per Bangladesh fiscal year (1 July–30 June)** via `platform_counters`,
  allocated under a row lock;
- VAT is computed per line from dated `vat_rates` (Finance Act changes usually take effect 1 July, so rates are data);
- consumer prices are shown VAT-inclusive (the retail norm), with the invoice breaking VAT out;
- `seller_bin`, optional `buyer_bin` (for VAT-registered business buyers), `fiscal_year` and the tax-invoice format are stored;
- partner payouts carry `withholding_vat_bdt` / `withholding_tax_bdt` and a certificate reference, in case VDS/TDS applies;
- platform-level payments (`payments.tenant_id` NULL) cover fees partners pay the platform.

**Not decided here:** the actual VAT rates for each stream, the exact Mushak form, and whether VDS/TDS applies to partner
payouts. The schema supports any answer; the numbers come from the accountant.

### Q11: refund approval authority

Tenant admins approve refunds up to `tenant_refund_approval_limit_bdt` (default ৳1,000), and **only** back to the original
payment method. Anything above, and every manual payout to a different wallet, needs platform approval, and nobody approves
their own request. In Bangladesh the common refund fraud is redirecting money to an accomplice's bKash or Nagad number; the
original-method restriction closes that route at the tenant level.

### Q12: marginal slabs on net revenue

Revenue share uses **marginal** slabs (each band at its own rate, like income tax), avoiding the whole-tier cliff that invites
end-of-month gaming. The basis is revenue **net of VAT, gateway fees and refunds**: VAT belongs to the government, and fees
and refunds never reached anyone. One slab set covers all streams at launch; periods are Dhaka calendar months.

### Q20: posting economics and moderation defaults

- **3 free posts** per member per month per tenant (`free_posts_per_month`, tenant-overridable): enough for households
  selling occasionally, while pushing frequent sellers to credits or a store plan (the familiar Bangladeshi classifieds model).
- **Tenant default: post-moderation** (publish immediately) with auto-hide at `auto_hide_report_threshold` (3) distinct reports.
  This keeps listings fast for the common case, and moderators aren't a bottleneck in small partners' teams.
- **Pre-moderation for scam-prone categories** by default: mobile phones, jobs, property/rentals, livestock with advance
  payment (especially around Eid), visa/travel. These are where advance-payment scams concentrate. Tenants can make a
  category stricter, never looser.

## Consequences

- An accountant review is a hard prerequisite for the payments migration.
- Price-bound, invoice-numbering, refund-authority, cash-control and moderation-mode tests are in §15.3 T.

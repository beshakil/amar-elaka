# ADR 016: Tenancy, membership, phone numbers, categories and landmarks

**Status:** Accepted (Q3, Q4, Q6, Q23, Q24, Q28, Q31)
**Date:** 2026-09-17
**Schema:** [§2.3 `tenants`](../specs/schema.md), [§2.7 `users`](../specs/schema.md), [§2.11 `tenant_members`](../specs/schema.md), [§4.4 `places`](../specs/schema.md), [§13.26](../specs/schema.md), [§13.37](../specs/schema.md)

## Decisions

### Q3: strictly one live tenant per upazila or metro thana

The upazila and metro thana are how Bangladeshi people and government name "my area", and they're BBS's statistical unit.
One tenant per unit keeps ownership, moderation and billing unambiguous. A partner who wants two adjacent upazilas operates
two tenants (`partners` → `tenants` is 1:N), with separate books. No `tenant_areas` table.

### Q4: implicit membership on first write

Membership is created automatically on the user's first authenticated write in a tenant (post, chat, review, report,
purchase, blood-donor registration, saved post). Browsing never creates one, and there's **no residency requirement**:
people regularly buy and sell in the neighbouring upazila's haat. This keeps onboarding friction-free (no "choose your
area" gate) while ensuring every tenant-scoped write has a member. The only exception is the credit-port rule (ADR 009),
which never creates a membership just to move money.

### Q6: no credit transfers between tenants

Neither users nor support can move credits between tenants. Different tenants price credits differently (ADR 017), so
transfers would invite arbitrage and laundering, and each transfer would need the full liability machinery. The **only**
cross-tenant movement is the audited closure port (ADR 009).

### Q23: no tenant-local categories

Categories stay global, so search facets, price analytics and moderation rules are consistent nationwide. Partners
request a new category (e.g. a local fish variety or a specific livestock market) through a `category_request` support
ticket; the platform adds it globally, and other tenants can enable it.

### Q24: Bangladeshi mobile numbers only for signup in v1

`users.phone_e164` must match `+8801[3-9]XXXXXXXX` (operator prefixes 013–019).

- **OTP cost and reliability:** local SMS aggregators deliver domestic OTPs cheaply and reliably; international SMS is expensive and patchy.
- **Fraud:** foreign and virtual numbers are a common vector for scam accounts on Bangladeshi classifieds.
- **Scope:** place and emergency-contact phone columns still accept any E.164 number or short code (landlines, 999).
- **Later:** diaspora access (e.g. family buying property from abroad) can be added with stronger KYC.

### Q28: buffer-zone posts pay from the owning tenant's wallet

A post that lands in a neighbouring tenant (ownership rules, §13.26 of the schema) is paid from that tenant's wallet. The app shows
"this will be listed in X" before payment, and the owning tenant's free monthly posts usually cover the occasional
cross-border listing. This keeps billing = ownership, with no inter-tenant transfers.

### Q31: landmarks are staff-only, with an optional per-place radius

Only staff mark landmarks (a district hospital, upazila health complex, railway station, launch ghat, bus terminal). Those
serve several upazilas, so `places.landmark_radius_km` can override the default `landmark_default_radius_km` (10 km).
Edits stay with the owning tenant.

## Consequences

- The signup CHECK needs a migration to widen later; that's deliberate, since loosening it should be a reviewed change.
- `tenant_members` INSERT policy allows only self-joins as `member`, triggered by the service on first write.

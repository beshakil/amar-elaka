# ADR 018: Privacy, retention and safety defaults

**Status:** Accepted (Q13, Q14, Q16, Q17, Q18, Q19, Q22, Q29, Q30)
**Date:** 2026-09-17
**Schema:** [§8.3 `messages`](../specs/schema.md), [§8.5 `notifications`](../specs/schema.md), [§9.3 `verification_requests`](../specs/schema.md), [§9.8 `bans`](../specs/schema.md), [§9.10](../specs/schema.md), [§10.4 `blood_donors`](../specs/schema.md), [§13.37](../specs/schema.md)

## Context

Bangladesh's personal-data-protection law was still being finalised when this was written, so these defaults follow
widely accepted data-minimisation practice rather than a single statute. They're conservative enough to fit a
consent-and-minimisation regime, and every period is a setting, so aligning with the final law is a data change.

## Decisions

### Q13: no blanket staff access to private chats

Tenant staff and partners can't browse users' chats. Access is only through a report on a specific message (scoped,
logged in `audit_logs`), or through a platform-managed legal hold for authorities (ADR 012). This is stated plainly in the
Bangla and English privacy policy. Small-town partners often personally know the users, which makes blanket access a
real privacy risk.

### Q14: unsend hides; bodies kept 180 days, then purged

"Unsend" hides a message from participants immediately. The body and media are kept for `message_body_retention_days`
(180) for trust and safety, since scam disputes typically surface within weeks, then removed by
`purge_message_bodies()`. Messages linked to reports, ban evidence or a legal hold are kept.

### Q16: one global notification inbox per user

The user is global, so their payment receipts and appeal outcomes shouldn't disappear when they switch area. Each item
shows its tenant.

### Q17: KYC handled by the platform, with minimal retention

- **Only platform staff** review NID, passport or birth-certificate submissions. Partners never see ID documents.
- **Images are purged** `kyc_document_retention_days` (90) after the decision by `purge_verification_documents()`. Only
  the NID hash, last 4 digits and outcome remain, and a raw NID number is never stored.
- **Election Commission NID verification** (the Porichoy service) can be integrated later through
  `verification_requests.provider_code`, subject to an agreement with the provider.

### Q18: log retention

- `audit_logs`: permanent.
- `lead_events`: 13 months (a full year plus a month, for year-on-year seller analytics and billing disputes).
- `activity_logs`: 90 days.

All three periods are settings.

### Q19: blood donors: no sex or date of birth

Donors aren't asked for sex or date of birth. A single `blood_donation_interval_days` (120, the 4-month interval commonly
used by Bangladeshi voluntary donor organisations) determines eligibility. Donors self-declare age and health eligibility
with recorded consent. Health-adjacent data is kept to the minimum, and donor lists are visible only to signed-in members.

### Q22: contact-intent tracking only in v1

The platform counts taps (call, WhatsApp, SMS, phone reveal, directions). Masked-number call tracking with a local telephony
provider can come later behind the existing lead model.

### Q29: `restricted` vs `banned`

Both can sign in with the appeal-only scope (ADR 005/§9.10). `restricted` leaves the user's existing public content
visible; `banned` hides it. This lets moderators stop further activity without erasing a seller's honest history, or
remove both when the content itself is the problem.

### Q30: ban escalation lookback

The 7d → 30d → permanent ladder counts only upheld bans (not revoked on appeal) in the **same tenant** within
`ban_escalation_lookback_days` (365). People change, and old mistakes shouldn't escalate forever. A global blacklist entry
doesn't consume a tenant's ladder.

## Consequences

- Retention jobs (`purge_message_bodies`, `purge_verification_documents`, partition drops) follow the `purge_*` naming
  convention, so the schema audit verifies each checks legal holds.
- The privacy policy must reflect Q13, Q14, Q17 and Q19 in Bangla and English before launch.

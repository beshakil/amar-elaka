# ADR 047: User-contributed places, revision history and the claim flow ("এই দোকানটি আমার")

**Status:** Accepted (2026-10-07).

**Code:**

- API: `apps/api/src/places/` (`places.{controller,service,repository}.ts`, `place-claims.{controller,service}.ts`,
  `place-view.ts`, `dto/places.dto.ts`); OTP purposes in `apps/api/src/auth/otp/otp.service.ts`
- Migration: `0042_place_contributions_and_claims`
- Tests: `test/places.db-spec.ts`, `test/places.e2e-spec.ts`, `src/auth/otp/otp.service.spec.ts`

## Context

Cold start: a new area has no stores on the platform. Field agents and users map shops first; the owners claim them
later. The schema already had `places`, `place_hours`, `place_claims` and `stores.place_id` (0005/0006), but no API.

It also had three gaps:

- Any active member could set `claimed_by_member_id` on a place through a plain INSERT/UPDATE.
- A contributor could not read back their own pending place.
- `moderation_actions` could only target posts.

## Decision 1: places are owned like posts, gated like posts

- **Ownership:** `POST /places` resolves the owning tenant with the posts rule: boundary, then buffer, then fallback
  (`PostOwnershipService`, `resolve_owning_tenant`). Every write runs in that tenant's context with the caller's
  membership there.
- **What goes live at once:**
  - field agents (`role = agent`; source `agent_survey`, `field_verified_at` set);
  - staff;
  - members whose trust is at or above `place_contribution_trust_threshold` (default 60, the posts threshold).
- **What waits:** everything else, and anything beyond every buffer, is `pending_review`. The moderation queue for
  places is the status itself: `GET /places/review-queue`, `POST /places/:id/approve|reject`. Each decision writes a
  `moderation_actions` row in the same transaction.
- **Landmarks:** `is_landmark` and `landmark_radius_km` are for moderators only. The API answers 403; the 0005 trigger
  already reverted them silently.
- **Photos:** images go in `media_attachments.place_id`. The street photo is one of them and is also pointed to by
  `places.street_photo_media_id`. It is attached too, so the orphan sweep never deletes it.
- **Database guard:** a new trigger `places_protect_system_columns` stops non-staff from writing
  `claimed_by_member_id`, `claim_store_id`, `created_by_user_id` and the ratings. A claimed owner may only move the
  place between published and temporarily/permanently closed.

## Decision 2: every edit is a revision, written by the database

`place_revisions(place_id, changed_fields jsonb, changed_by_user_id, kind_code, reverts_revision_id, xact_id)`:

- **Written by the database:** an AFTER trigger on `places` (SECURITY DEFINER) diffs the versioned columns. So no code
  path can change a place without leaving history.
- **Format:** `changed_fields` is `{field: {from, to}}`. Location is stored as `{lat, lng}`.
- **Opening hours** live in `place_hours`. The API calls `record_place_hours_revision(place, from, to)` in the same
  transaction; only an editor of the place may call it.
- **One revision per place per transaction.** Later changes in the same transaction merge into it: earliest `from`,
  latest `to`, and a field changed back drops out.
- **Append-only once committed** (trigger). The app role has no write grant on the table at all.
- **Reads:** the people who may edit the place, in its owning tenant (staff, agents, the claimed owner).
- **Revert:** `POST /places/:id/revisions/:rid/revert` is staff only and calls `revert_place_revision()`. It puts the
  revision's `from` values back for content fields only; status and ownership have their own flows. It refuses
  (409 `PLACE_REVISION_SUPERSEDED`) when a field changed again since, so a moderator reverts newest first and never
  silently undoes a good later edit. The revert is itself a `reverted` revision and a `moderation_actions` row.

## Decision 3: claims — configurable evidence, one transaction to approve

**Evidence.** At least one kind is required. A tenant picks the kinds it accepts with `place_claim_evidence_methods`
(tenant-admin override):

- `otp_to_listed_phone`: `POST /places/:id/claim/otp` sends a code to a number already on the place.
- `shop_front_photo`: a photo of the owner at the shop front.
- `trade_license`: trade licence pages.

The photo and licence are uploaded as `document` media (the private bucket) and attached through
`media_attachments.place_claim_id`.

**The OTP is its own purpose** (`OtpService` `{kind: 'place_claim', scope: claimant:place}`):

- A separate Redis slot and HMAC domain, so a claim code can't log anyone in and doesn't overwrite a pending login code.
- Bound to the claimant and the place.
- Its own SMS text, which tells the owner someone is claiming their shop.
- The cooldown and daily limits stay per phone, to protect the shop's number from SMS bombing.

**Auto-approval.** An OTP-verified claim is approved at once when `place_claim_otp_auto_approve` is on (default off;
tenant-admin override). Otherwise it waits: `GET /place-claims/queue`, `POST /place-claims/:id/approve|reject`.

**Approval is `approve_place_claim()`, one transaction:**

1. Lock the claim, then the place.
2. Create the claimant's store, or link `storeId` if it is theirs and not another place's pin. The store is `active`.
3. Set `place.claimed_by_member_id` and `claim_store_id`. The store takes the place's location, so the place is the
   store's map pin.
4. Carry over: saves of the place become saves of the store; reviews of the place move to the store, unless the
   reviewer already reviewed it. Ratings are recomputed.
5. Reject the competing pending claims (`place_already_claimed`).
6. Write a `moderation_actions` row for the approval and for each rejected claim.

The claimant and the losers are notified after commit (`place_claim_approved` / `place_claim_rejected`).

**Concurrency.** Two approvals for one place serialise on the place's row lock; the second finds it claimed (AE211).
`place_claims_one_approved_uq` (one `approved` claim per place) backs this in case anything ever bypasses the lock.

**Other rules:**

- A moderator can never decide their own claim.
- A claimant can trigger approval only for their own OTP-verified claim, and only where the tenant allows it.
- Status and review columns are protected by a trigger: a claimant's claim always starts `pending`.
- One pending claim per person per place (0005 index); competing claims from different people are allowed.

## Decision 4: `moderation_actions` targets places and claims

- `post_id` becomes nullable. This relaxes a NOT NULL constraint; no column is dropped or renamed.
- New targets `place_id` and `place_claim_id`, with exactly one target per row (CHECK).
- New action codes: `claim_submitted`, `claim_approved`, `claim_rejected`, `reverted`.
- New reasons: `otp_verified`, `owner_request`, `place_already_claimed`.
- A claimant may insert only their own `claim_submitted` row.

## Decision 5: RBAC

- New module `places`: members and sellers `read`/`write`, moderators also `approve`; tenant admins already have `*`.
- New built-in role `agent`. `tenant_members.role_code = 'agent'` existed, but no `roles` row did, so agents had no
  grants at all. They get `places` and the member's `posts` grants.

## Settings (rule 9)

| Setting                              | Default                              | Override     |
| ------------------------------------ | ------------------------------------ | ------------ |
| `place_contribution_trust_threshold` | 60                                   | platform     |
| `place_name_max_length`              | 120                                  | —            |
| `place_max_photos`                   | 10                                   | —            |
| `place_max_phones`                   | 3                                    | —            |
| `place_claim_evidence_methods`       | otp, shop-front photo, trade licence | tenant admin |
| `place_claim_otp_auto_approve`       | false                                | tenant admin |
| `place_claim_max_documents`          | 5                                    | —            |
| `place_claim_note_max_length`        | 1000                                 | —            |

Page sizes reuse `moderation_queue_page_size_default` / `_max`.

## Not in this change

- **Viewing claim evidence:** moderators get the evidence files' media ids, but there is no signed-URL download for the
  private bucket yet.
- **Not built:** claim withdrawal, claim revocation, duplicate-place detection and "my contributions" lists (week 9 or
  later).
- **Clients:** no screens in the app or web yet; notification texts render client-side per type when they are.

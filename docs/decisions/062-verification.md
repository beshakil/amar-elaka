# ADR 062: Store and member verification

**Status:** Accepted (2026-10-12).

**Code:**

- Database: `infra/migrations/0058_verification.sql`.
- API: `apps/api/src/verification/`
  - `nid.ts`: normalising and hashing the NID number;
  - `VerificationService`: the member's own and the store owner's requests, and evidence upload;
  - `VerificationModerationService`: the queue, the detail with signed URLs, and decisions;
  - `VerificationJobsService`: expiry, reminders and the document purge, run by the notifications worker.
- Admin: `apps/admin/src/app/(dashboard)/moderation/verifications/`, the queue and the side-by-side evidence
  view.
- Mobile: `apps/mobile/lib/features/verification/`
  - "পরিচয় যাচাই" from the profile, "দোকান যাচাই" from My Store;
  - the `identity_checked` badge on the seller card and the owner's identity on the store page.
- Web: the `identity_checked` seller badge on listings, and the owner's identity on the store page.
- Tests:
  - API: `apps/api/test/verification.db-spec.ts`, `apps/api/test/verification.e2e-spec.ts`,
    `apps/api/src/verification/nid.spec.ts`, `apps/api/src/architecture/unique-dto-names.spec.ts`;
  - mobile: `test/features/verification/`.

## Context

Buyers need a signal that a seller is a real, accountable person, and that a shop is a real shop.
Until now there were two signals, and neither was enough:

- **Phone verification.** It is automatic at sign-up, so it proves very little.
- **`stores.is_verified`.** Nothing set it.

0010 has two tables, `verification_requests` (global) and `business_verifications`. Nothing writes or
reads either one:

- `verification_requests` is not tenant-scoped, so an area's moderators can't own the queue.
- Its identity columns imply storing the document itself.

## Decision

### Three levels, one rule

| Level               | How                                                                                                | Valid                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `phone_verified`    | automatic: the user's phone is verified                                                            | —                                                                                                    |
| `identity_checked`  | NID number (hashed) + a selfie, checked by the area's moderators                                   | `verification_identity_valid_days`                                                                   |
| `business_verified` | trade licence + a shop-front photo with the owner, checked by moderators; optionally a field visit | `verification_business_valid_days`, or an earlier date the moderator sets (the licence's own expiry) |

- **One rule for the levels.** `verification_level_of_user`, `verification_level_of_member` and
  `verification_level_of_store` decide a level in one place. They count only approved, unexpired rows.
- **Who reads them.** Every badge reads these functions:
  - the store page's `verification.badge`;
  - the post detail's seller badges;
  - `stores.is_verified`.
- **Caches.** `stores.is_verified` and `seller_profiles.verification_level_code` are caches. Only
  `refresh_verification_caches` writes them, and it runs on every approval, expiry and supersession.
- **Expiry drops the badge.** No job has to run first: the functions compare `expires_at` with `now()`.
  The expiry job then marks the row `expired` and refreshes the caches.
- **A store's badge.**
  - A verified business shows the business badge.
  - Otherwise the store shows its owner's level, so a store whose owner has a checked identity shows
    "মালিকের পরিচয় যাচাই করা".
- **Prerequisites.** Business verification needs the owner's identity first; identity needs a verified
  phone.

### The NID number is never stored

- **The number.** It travels once, in the body of `POST /me/verifications/identity`. The API normalises
  it at once (Bengali digits, spaces, dashes; 10, 13 or 17 digits).
- **What is kept.**
  - `nid_hash`: an HMAC-SHA256 under the server-side pepper `NID_HASH_SECRET`, a required env var of at
    least 32 characters;
  - `nid_last3`: the last 3 digits, for support lookups.
- **Why a pepper.** A plain hash of a 10–17 digit number can be brute-forced; a keyed hash can't without
  the secret.
- **Duplicates.** The same hash on another account sets `nid_duplicate` for the moderator. It does not
  refuse the request, because a family shares a phone more often than a fraudster shares an NID.
- **The NID card image.** It is never asked for. Identity is the number plus a selfie.
- **Logs.** The request logger redacts `nid` (`logging/pino-http-options.ts`).
- **Tested.**
  - The e2e test submits a number, then scans every text and jsonb column of the database.
  - The test also checks every response, to confirm the raw number appears nowhere.

### Documents: private, signed, purged

- **Storage.** Evidence uploads go to the private `documents` bucket. Photos use the new media kind
  `verification_image`, which is re-encoded like any image, so EXIF and GPS are stripped. A trade licence
  may also be a PDF (kind `document`).
- **Access.** Nothing serves the bucket publicly; `/media/*` serves only the media bucket.
- **Moderators.** They get URLs signed for `verification_doc_url_ttl_seconds` from
  `GET /verifications/:id`.
- **Purge.**
  - `verification_doc_retention_days` after a decision, `purge_verification_documents` marks the
    evidence media for purge (`media_assets.purge_due_at`), and the existing media purge job deletes the
    files.
  - It checks `legal_hold_blocks` first, for the user, the store and each media asset (rule 11).
  - The verification row and its hash stay, so the badge history survives.
- **The orphan cleaner.** `media_asset_is_referenced` now counts `verification_evidence`, so the cleaner
  can't delete evidence that is still waiting.

### Who decides

- **The area's moderators**, not only platform staff. The new grants `verifications:read` and
  `verifications:approve` go to the moderator role.
- **Area.**
  - A member's identity request belongs to the area where it was submitted.
  - A store's request belongs to the store's area.
- **Decisions.** `decide_verification` takes approve, reject (with a reason) or request a visit.
  - A moderator can't decide their own request.
  - Every decision writes `moderation_actions` (new `verification_id` target) in the same transaction
    (rule 13).
  - An approval supersedes the subject's previous approval at that level.
- **A field visit** is only a request flag for now: `visit_status` = `requested`, plus a
  `verification_visit_requested` moderation action. Agent assignment comes with field agent mode, and
  `agent_visit_id` is reserved for it.

### Expiry and reminders

- **`expire-verifications`** runs hourly:
  - it sends `verification_expiring` `verification_reminder_days_before` days ahead, once per approval
    (`reminder_sent_at`);
  - it marks passed approvals `expired`, refreshes the caches and sends `verification_expired`.
- **Renewal.** A new request is allowed once the current approval is inside the reminder window.
- **`purge-verification-documents`** runs daily.
- **Batches.** Both jobs work in batches of `verification_job_batch_size`.

### API

| Route                                                                                                                                  | Who                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `GET /me/verifications`, `POST /me/verifications/identity`, `POST /me/verifications/evidence` (+ `/:mediaId/confirm`, `GET /:mediaId`) | the member                       |
| `GET /stores/:id/verification`, `POST /stores/:id/verification`, `…/evidence`                                                          | the store's owner                |
| `GET /verifications/queue`, `GET /verifications/:id`, `POST /verifications/:id/decision`                                               | `verifications:read` / `approve` |

Errors AE701–AE704 map to `VERIFICATION_NOT_ALLOWED` (with a `reason`), `VERIFICATION_EVIDENCE_INVALID`,
`VERIFICATION_NOT_FOUND` and `VERIFICATION_DECISION_INVALID`.

### The old tables stay

- `verification_requests` and `business_verifications` (0010) are left in place, unused and not dropped:
  no migration drops a column or table without its own flagged change.
- `stores.business_verification_id` is unused as well.
- Removing them is a later cleanup.

## Consequences

- **Deployment.** `NID_HASH_SECRET` must be set in every environment before this deploy; the API refuses
  to start without it.
- **Never rotate the pepper.** Rotating it orphans every stored hash, so the duplicate check stops
  matching. Treat it like a database key.
- **Retention.** Moderators have `verification_doc_retention_days` after a decision to revisit
  evidence. After that, only the decision, the reason and the hash remain.
- **Clients.** Requests are made from the mobile app, which uploads photos only. The API accepts a PDF
  licence, and the admin view shows one, but no client sends one yet: a web seller-panel form is a later
  step.
- **A gap this closed.** `ReviewQueueDto` existed both in places and in reviews, and OpenAPI silently
  kept one of them. The reviews one is now `ReviewModerationQueueDto`, and
  `unique-dto-names.spec.ts` guards against the next collision.

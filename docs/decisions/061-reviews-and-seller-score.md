# ADR 061: Reviews and the seller score

**Status:** Accepted (2026-10-11).

**Code:**

- Database: `infra/migrations/0057_reviews.sql`.
- API: `apps/api/src/reviews/`
  - `ReviewsService` (members and the store), `ReviewModerationService` (queue, decision, scrub);
  - `ReviewPromptsService` (the "how was it?" job, run by the notifications worker);
  - `SellerScoreService` with the pure `seller-score-formula.ts`, in its own `SellerScoreModule`
    (read by the store page, the post detail and reviews).
- Mobile: `apps/mobile/lib/features/reviews/` (section on the store page, full list, write/edit), the
  tier on the store page and the post detail's seller card, the prompt's deep link.
- Web: the store page's reviews and tier, `/reviews/write`, the seller panel's `/seller/[storeId]/reviews`
  (reply), the tier on the listing's seller card.
- Tests:
  - `apps/api/test/reviews.db-spec.ts`, `apps/api/test/reviews.e2e-spec.ts`,
    `apps/api/src/reviews/seller-score-formula.spec.ts`;
  - mobile `test/features/reviews/` (widgets, goldens);
  - web `lib/notifications/links.test.ts`.

## Context

The schema has had `reviews` and `review_responses` since 0010, but nothing used them. Two problems with
them as they stood:

- **Anyone could review anything.** Any member could insert a review row directly (RLS allowed it).
- **Nothing tied a review to a real contact.** The rating cache `stores.rating_avg` was even writable by
  the store's owner.

## Decision

### The anti-fake rule: a review needs a real contact

- **Who may review.** A member may review a store only if a `lead_events` row shows they contacted it:
  call, WhatsApp, SMS, or a chat the store answered. That chat lead exists only after the seller's first
  reply (0054).
- **When.** The contact must be at least `review_min_hours_after_contact` and at most
  `review_window_days` old.
- **How many.** One review per member per store (the unique index of 0010). It is editable for
  `review_edit_days`.
- **Never** by the store's owner or staff.
- **The proof.** The newest qualifying contact is stored on the review (`lead_event_id`).
- **Proof by user, not membership.** `lead_events.actor_user_id` is new. A signed-in buyer contacting a
  post in a neighbouring area has no membership there (the contact reveal only looks one up), so
  `actor_member_id` was NULL and the contact proved nothing. Writing the review then creates the
  membership, like a first post.
- **The rule lives in one place.** `review_eligibility()` holds it, and `submit_review` re-checks it
  under a row lock. Members and tenant staff lost every direct write on `reviews` and
  `review_responses` (policies dropped, grants revoked). All writes go through SECURITY DEFINER
  functions.

### Integrity: flag and queue, don't silently drop

A review is held as `pending`, with its reasons in `flags`, when any of these is true (every threshold is
a setting):

| Flag            | When                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `low_trust`     | the author's trust score (TrustScoreService, the one trust rule) is below `review_low_trust_threshold`                                                                                                                         |
| `burst`         | `review_burst_count` reviews of the store within `review_burst_window_hours`                                                                                                                                                   |
| `shared_device` | the author shares a device fingerprint or push token with the store's owner or staff                                                                                                                                           |
| `phone_pattern` | the author's number shares its first `review_phone_prefix_length` characters with the owner's or staff's (sequential SIMs), or with `review_phone_pattern_min_reviewers` recent reviewers of the store                         |
| `similar_text`  | trigram similarity (pg_trgm, works on Bengali under the UTF-8 locale) with another review of the store is at least `review_text_similarity_threshold`; texts shorter than `review_text_similarity_min_length` are not compared |

- An edit re-checks the content flags (device, phone, text); the trust and burst flags stay with a review
  still waiting.
- Moderators get one queue (`GET /reviews/queue`): held reviews, plus published ones with open reports.
- A moderator can publish, hide or remove one. `decide_review` writes `moderation_actions` (new
  `review_id` target) and closes the review's reports in the same transaction (rule 13). An author's
  edit can't undo a decision.

### The store: reply and report, never delete

- **Reply.** The owner or an accepted manager writes one reply per review, and can edit it
  (`respond_to_review`).
- **Report.** Anyone, the owner included, can report a review (`report_review`; new reason
  `fake_review`).
- **No delete.** No role in the app can delete a review. The rating columns on `stores` are written only
  by the review trigger (or the system); before this, an owner's ordinary row update could set them.

### Scrubbing an author

- `scrub_review_author(user, reason)` is for platform admins, via a privacy request (`POST
/platform/users/:id/reviews/scrub`). It removes the text and photos of every review the user wrote
  and marks the author as removed: the list shows "সাবেক সদস্য" with no name.
- The rating stays, and so does its weight in the aggregate and the score.
- It is refused outright under a legal hold on the user (rule 11), and skips reviews of a store under
  hold. Each scrubbed review records `privacy_scrub`.

### The seller score

- **Range.** 0–100, from the store's inputs.
- **Rating.** A Bayesian average: the prior `seller_score_prior_mean` counts as
  `seller_score_prior_weight` reviews. So one 5★ (≈4.09) can't outrank fifty 4.6s (≈4.5).
- **Chat.** Response rate, and the median time to the first reply, over
  `seller_score_response_window_days`. With fewer than `seller_score_min_conversations` chats, both
  earn half their points.
- **Age and verification.** The store's age, and its verification level (phone ⅓, identity ⅔,
  business 1, of the weight).
- **Penalty.** Each upheld report against the store, its posts or its owner costs points.
- Every weight is a setting.
- **One implementation.** `SellerScoreService` is cached in `store_seller_scores`. A review, an upheld
  report or a verification change marks it stale; it also expires after `seller_score_cache_hours`,
  because chat stats change without an event.
- **Shown as a tier, never as the number:**

| Tier                 | When                                                             |
| -------------------- | ---------------------------------------------------------------- |
| top / trusted / good | from `seller_score_tier_*`                                       |
| new                  | fewer than `seller_score_min_reviews_for_tier` published reviews |
| none                 | otherwise: no badge                                              |

### "How was it?"

- The job `send-review-prompts` runs every 15 minutes. It sends `review_prompt` (in-app and push)
  `review_prompt_hours` after a contact.
- At most once per member per store, ever (`review_prompts`). Never to the store's own people, and
  never for a store the member already reviewed.
- Never for a contact older than `review_prompt_max_age_hours` (no backlog after downtime).
- It goes through NotificationService, so preferences, quiet hours and the daily caps apply. The deep
  link `/stores/<id>/review` opens the review form on both clients.

## Consequences

- The old RLS tests that let a reviewer or staff update a review directly were rewritten. Direct writes
  now fail with 42501 for everyone in the app role.
- A store page and a post detail read the tier through one service, so one score defines what everyone
  sees.

## Not built (yet)

- Reviews of places and of individual sellers. The schema allows them (0010), but they have no rule
  yet.
- An author deleting their own review: decided against for now (edit only), so pressure from a seller
  can't make reviews disappear.
- A "seller replied to your review" notification.

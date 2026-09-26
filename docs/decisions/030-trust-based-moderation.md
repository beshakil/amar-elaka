# ADR 030 — Trust-based moderation: trust score, pre-filter, queue

**Status:** Accepted (2026-09-25). Code: `apps/api/src/trust`, `apps/api/src/moderation`,
`apps/api/src/notifications`, `apps/admin/src/app/(dashboard)/moderation`, migration 0027. Refines ADR 029 §2
(moderation mode): a post-moderated category no longer auto-publishes every post, only posts by trusted authors.

## Decisions

**1. A trust score per membership, not per user.** `member_trust_scores` has one row per `tenant_members` row, with
a score from 0 to 100. A seller trusted in one thana starts fresh in the next, because each tenant's partner moderates
their own area. The row stores `components` (each input's contribution), `algorithm_version`, and an optional
`override_score` + `override_reason` so staff can pin a score by hand. Members read their own row; staff read their
tenant's; only the system writes (RLS).

**2. The formula** (`trust-formula.ts`, pure, unit-tested). Every weight is a setting (`trust_*`):

```
score = base
      + min(approved × per_approved, max_approved)
      − rejected × per_rejected − removed × per_removed − upheld_reports × per_report
      + min(account_months × per_month, max_age)
      + phone_verified + store_verified
      − active_bans × per_ban
clamped to 0–100
```

"Approved" means posts that went live (live/sold/expired). Rejected and removed counts come from the moderation queue's
resolutions, so a post that is later scrubbed still counts against its author.

**3. Recompute on events, not on a cron.** Every moderation action recomputes the author's score after commit.
Anything else can call `markStale()`, and `get()` recomputes lazily on the next submission. There is no nightly job
to fall behind.

**4. The submission decision** (`ModerationDecisionService.decide`), in the author's transaction:

1. Forced review → `pending`: the category or tenant is pre-moderated (`pre_moderation`), the post is beyond the
   buffer (`outside_boundary`), or it is a resubmission after a moderator's reject or remove (`resubmission`).
2. Any pre-filter flag → `pending`, with the flags as reasons.
3. Trust ≥ `trust_auto_approve_threshold` → `live`. `moderation_sample_rate_percent` of these still get a `sample`
   queue item for after-the-fact review.
4. Otherwise → `pending` (`low_trust`).

A new member's base score (20) is below the default threshold (60), so their first posts always reach a human.

**5. Pre-filter** (`prefilter.ts` + repository queries). Every limit is a setting:

| Flag             | Rule                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `banned_keyword` | `moderation_banned_keywords` (`text_array`), matched on normalized text                                                                      |
| `contact_info`   | a BD mobile number in title or description, including Bengali digits and separators                                                          |
| `link_spam`      | more than `moderation_max_links_per_post` links                                                                                              |
| `duplicate`      | same author, same title and same photo checksums within `moderation_duplicate_window_hours`                                                  |
| `price_outlier`  | price off the category median by more than `moderation_price_outlier_factor`, once there are at least `moderation_price_min_samples` samples |

Banned keywords are a `text_array` setting: the platform default list, which a tenant admin can override for their own
area. The normalization is the same as search's (Month 1 `normalizeSearchText`), so spacing and case tricks don't
get past the filter.

**6. The queue** is `moderation_queue_items`: one open item per post (partial unique index), with source
`submission` / `sample` / `rereview`, the reasons, and the author's trust score at filing time. Authors can't read it.
They file through `file_moderation_item()` (SECURITY DEFINER), which checks that the caller is the author, staff or
the system, and takes the author from the post. A resolved item keeps `author_member_id` even after a scrub, which is
what makes it the per-post ledger in point 2.

**7. The moderation API** (`/moderation`). Queue actions need `posts:approve`; hard removal needs `posts:delete`
(tenant admin).

- `GET /queue`: filter by reason, category and age; oldest first; cursor pagination.
- `approve`, `reject`, `remove`: each goes through the state machine.
- `hard-remove`: `deletion_reason = moderator_removed` plus `scrub_post()` (ADR 006). It needs a reason text and at
  least one evidence reference.
- `bulk`: approve or reject up to `moderation_bulk_max` posts. Each post runs in its own transaction, and the response
  gives per-post results.

Every action does the following in one transaction: the status change, a `moderation_actions` row, the queue item
resolved (or a resolved item written, if the moderator acted on an unqueued post), and a `post.*` outbox event.

**8. Legal hold wins over scrub.** Hard removal checks `legal_hold_blocks('post', id)` first. It returns 409
`LEGAL_HOLD_BLOCKS_SCRUB` with nothing changed. `scrub_post()` repeats the check inside the database (`AE100`). It also
refuses (`AE101`) unless a `moderator_removed` or `privacy_scrub` action was recorded in the same transaction, so no
code path can scrub without an audit row.

**9. Notifications are pluggable.** `NotificationService` fans out to every `NotificationChannel` registered under
`NOTIFICATION_CHANNELS`. Today that is only in-app (the `notifications` table, with a dedupe key per post and outcome);
push (week 11) is one more channel. Owners are notified on approve (for a pending post), reject, remove and hard
remove. A failing channel is logged and never undoes the moderation action.

**10. Admin.** One page: `/moderation` on `CrudPage`. It has a reason filter and per-row approve / reject / remove,
plus hard remove for viewers with `posts:delete`. Reasons are chosen in a dialog. Bulk actions are API-only for now.

## Consequences

- Tuning is data, not code: 22 settings, all overridable per tenant.
- `tests`: formula, pre-filter and decision unit tests; `trust-moderation.db-spec.ts` (RLS and function guards);
  `moderation.e2e-spec.ts` (new user → pending, trusted → live, trusted + banned keyword → pending, legal hold →
  409 with no scrub, and the rest of the API). The posts e2e sets threshold 0 and sample 0 on its own tenants
  (`setting_overrides`, never `platform_settings`, since e2e suites run in parallel), so it keeps testing the state
  machine, not trust.
- Not yet: reports (`upheld_reports` counts `actioned` reports once that module exists), a UI for trust overrides,
  and push delivery.

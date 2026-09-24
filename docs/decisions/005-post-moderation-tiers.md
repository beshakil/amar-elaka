# ADR 005: Three moderation tiers for posts

**Status:** Accepted (Q35); legal-hold correction confirmed (Q45) → ADR 012
**Date:** 2026-09-17
**Schema:** [§4.2 `posts`](../specs/schema.md), [§9.11 `moderation_actions`](../specs/schema.md), [§13.31](../specs/schema.md)

## Context

Moderators do two very different things. Most takedowns are routine (spam, wrong category,
duplicates, policy violations): the seller made a mistake and should be able to fix it. A few are
serious (illegal content, doxxing, CSAM, credible threats): the content must not remain queryable,
even to its author. A third case, legal holds, requires content to be **preserved** for authorities
while hidden from everyone else. One mechanism can't serve all three.

## Decision

| Tier              | Mechanism                                                                | Content                                          | Owner                                                                |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------- |
| Ordinary takedown | `posts.status_code = 'removed'`, `deleted_at IS NULL`                    | Intact                                           | Sees it with the reason; can edit and resubmit (`removed → pending`) |
| Hard removal      | `deletion_reason_code = 'moderator_removed'`                             | Scrubbed immediately (ADR 006), media purged now | Sees only that it was removed                                        |
| Legal hold        | `deletion_reason_code = 'legal_hold'` + open `legal_holds` row (ADR 012) | Retained in full; exempt from every purge        | Can't see it; only platform                                          |

- **Every** `removed`, `restored`, `moderator_removed`, `legal_hold` placement/clearance, spam auto-deletion
  and privacy scrub writes a `moderation_actions` row (post, actor, action, reason code, reason text,
  evidence refs). A deferred commit-time trigger on `posts` rejects the change unless that row was
  written **in the same transaction** (`xact_id = pg_current_xact_id()`). **No takedown without a
  recorded reason.**
- Hard removal and legal hold require written reason text and at least one evidence reference (CHECK).
- Only a `platform_admin` can clear a legal hold.

## Reasoning

- Keeping ordinary takedowns as a **status** keeps the row, lets the seller correct honest mistakes,
  and preserves moderation history without deleting anything.
- Hard removal scrubs because keeping illegal content or a doxxing victim's address queryable is the
  harm itself; the row stays so the action remains auditable.
- A same-transaction check (rather than "a row exists at some point") prevents a takedown from ever
  committing without its justification, even from a buggy code path or a manual SQL session.

## Legal hold: correction adopted (Q45, CONFIRM 1)

The original wording ("same as `moderator_removed`") would have scrubbed exactly what a hold must preserve. The
correction is **adopted**: a hold retains content in full (no scrub, no media purge, no anonymise), is exempt from every
purge job, and is scrubbed only when a `platform_admin` releases it, recording who and why. Holds are now a registry
covering posts, media, users, conversations, messages and stores. **See [ADR 012](012-legal-holds.md)**, which
supersedes this section.

## Consequences

- Moderation UIs must always capture a reason code (and text/evidence for the serious tiers).
- CSAM should normally go through **legal hold**, not straight to `moderator_removed`, so evidence isn't destroyed.
- `status_code` and `deletion_reason_code` enums must never share a value; the schema audit checks this (`status_deletion_enum_overlap`).

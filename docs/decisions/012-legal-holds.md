# ADR 012: Legal holds retain content in full and block every purge, scrub and anonymise job

**Status:** Accepted (CONFIRM 1 / Q45). Supersedes the legal-hold wording in ADR 005
**Date:** 2026-09-17
**Schema:** [§11.9 `legal_holds`](../specs/schema.md), [§4.2 `posts`](../specs/schema.md), [§13.31](../specs/schema.md), `scripts/audit-schema.sql` check `purge_job_without_legal_hold_check`

## Context

A legal hold exists to **preserve** content for authorities (law-enforcement requests, CSAM reporting obligations,
litigation). The first wording ("same as `moderator_removed`") would have scrubbed exactly that content. Holds also
need to cover more than posts: a user's account under investigation, a conversation, individual media.

## Decision

1. **An open hold retains content in full.** No scrub, no media purge, no anonymise; exempt from **every** purge job
   (media purge, tenant archive purge, account-deletion anonymisation, message-body retention, partition drops, KYC
   document purge).
2. **Registry:** `legal_holds(id, subject_type, subject_id, reason, placed_by, placed_at, released_by, released_at,
scrub_on_release boolean default true)`, plus `subject_tenant_id`, `external_reference` and **`release_reason`**, so
   a release records **who** released it **and why**. Subjects: post, media_asset, user, conversation, message, store.
3. **Only a `platform_admin` releases.** On release with `scrub_on_release = true`, the normal scrub runs for the subject
   (a post becomes `moderator_removed` and is scrubbed in the same transaction). With `false`, a hidden post returns to
   `removed` for review, unscrubbed. With several open holds on one subject, nothing is scrubbed until the last is released.
4. **Every purge/scrub/anonymise job checks first and skips.** Such logic lives only in DB functions named
   `purge_*`, `scrub_*`, `anonymize_*`, each calling `legal_hold_blocks(subject_type, subject_id)`. That function
   resolves transitive coverage (media via its post/message/uploader; post via its author; message via its conversation;
   conversation via participants; store via owner).
5. **Enforced in CI:** `scripts/audit-schema.sql` fails any such function that doesn't reference `legal_hold_blocks(`
   or carry an explicit `legal-hold-exempt: <reason>` comment (only for purges that can never touch a holdable subject,
   such as the outbox).

## Reasoning

- **Preservation is the whole purpose of a hold;** hiding without preserving would be a compliance failure, and
  scrubbing on placement would destroy evidence.
- **A registry instead of per-table flags:** one place to see every open hold, with who, why and when; it works for
  subjects in any table, including global users.
- **Polymorphic `subject_type`/`subject_id`** is a deliberate exception to §13.14 (explicit FKs): holds must cover any
  subject kind and outlive schema changes. Existence is checked by trigger at placement.
- **A naming convention plus a catalog check** turns "every job must remember to check" into something CI verifies. A
  purge implemented outside such a function (e.g. an ad-hoc `DELETE` in a worker) is a code-review violation.

## Consequences

- `media_assets.legal_hold` is renamed `evidence_hold` (evidence referenced by reports and bans) to avoid confusion
  with formal holds.
- `posts.legal_hold_cleared_at/by` are removed; release data lives on `legal_holds`.
- Tests (§15.3 R): a held post survives media purge, tenant archive and user-deletion requests; release records who
  and why and triggers the scrub.

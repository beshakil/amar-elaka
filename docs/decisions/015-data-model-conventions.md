# ADR 015: Data-model conventions: enum tables, partitioning, outbox

**Status:** Accepted (Q1, Q2, Q15, Q21)
**Date:** 2026-09-17
**Schema:** [§0.3](../specs/schema.md), [§12](../specs/schema.md), [§13.19](../specs/schema.md), [§11.8 `outbox_events`](../specs/schema.md), [§13.37](../specs/schema.md)

## Decisions

### Q1: enum tables use a `code text` primary key

Enum tables are the deliberate exception to "uuid v7 PKs". A readable code (`status_code = 'live'`) needs no join to
interpret, seeds are idempotent (`on conflict (code)`), and logs, dumps and support queries stay legible.

### Q2: enum tables for all closed value sets, lifecycle statuses included

Keep one pattern everywhere instead of splitting "vocabularies" (tables) from "statuses" (`CHECK`):

- **One mental model** for a small Bangladeshi team: every coded value is a row with an i18n `label_key` (Bangla and English).
- **The schema audit depends on it:** the status/deletion-reason overlap check (§15.3 A.6) reads FKs to enum tables.
- **Cost is negligible:** code-as-PK means a status column needs no join.
- **Drift guard:** a CI test asserts every DB seed matches the corresponding `as const` union in `packages/shared-types`,
  so code and data can't disagree.

### Q15: partition logs from day one; not `messages` in v1

- `lead_events`, `activity_logs`, `audit_logs`: monthly range partitions from the first migration (append-only, time-queried,
  retention by partition).
- `messages`: **not** partitioned in v1. Partitioning it would force `created_at` into its PK and into every FK that
  references a message (`reports`, replies), for little gain at hyperlocal chat volume. BRIN on `created_at` plus
  `message_body_retention_days` (ADR 018) keep it lean. Revisit if it passes roughly 50 million rows, using an online
  migration (new partitioned table + backfill).

### Q21: keep the transactional outbox

Search sync, notifications and settings invalidation must not be lost when a process dies between commit and enqueue,
which is common on a single VPS with deploy restarts. `outbox_events` is written in the same transaction and relayed
with `FOR UPDATE SKIP LOCKED`.

## Consequences

- New closed value sets always get an enum table plus seed plus TS union in the same change.
- The partitioning decision for `messages` is reversible later; the log partitioning isn't something to retrofit, so it's done now.

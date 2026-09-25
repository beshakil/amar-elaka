# Amar Elaka — Hyperlocal Multi-Tenant Platform

## What this is

A multi-tenant hyperlocal marketplace + service platform + local business
directory + local information platform for Bangladesh. Each tenant = one
thana/upazila, operated by a local partner. Built as SaaS from day one.

## Stack

- API: NestJS (TypeScript), REST, /api/v1
- DB: PostgreSQL 16 + PostGIS, Drizzle ORM, raw SQL migrations
- Cache/Queue: Redis + BullMQ
- Search: Meilisearch
- Storage: S3-compatible — Contabo Object Storage now, Backblaze B2 later (ADR 027); no local MinIO
- Web: Next.js 15 App Router (apps/web = public, apps/admin = dashboards)
- Mobile: Flutter (Riverpod + go_router + Drift)
- Deploy: Docker + Coolify on Contabo VPS

## Repo layout

apps/api, apps/web, apps/admin, apps/mobile
packages/shared-types, packages/config
infra/ (docker, migrations), docs/specs, docs/decisions

## HARD RULES — never violate

1. Multi-tenancy: every tenant-scoped table has `tenant_id uuid not null`.
   RLS is enabled on all of them. NEVER write a query that bypasses RLS.
   Tenant context is set per-request via `SET LOCAL app.tenant_id`.
2. Money: never float. Store minor units as integer (poisha) or numeric(12,2).
   All credit/payment mutations must run inside a DB transaction with row locks.
3. Input: every endpoint validates input with zod. No `any`. Strict TS.
4. Errors: typed exceptions, never leak stack traces or SQL to clients.
5. External calls: always timeout + retry + typed error. Never a bare fetch.
6. i18n: no hardcoded user-facing strings. Bengali is the default locale.
7. Every new table needs: migration + RLS policy + seed + test.
8. Never use `SELECT *` in application code.
9. Settings: no duration, limit, threshold or price is ever hardcoded in
   application code. If a number governs behaviour, it lives in
   `platform_settings` (global default) and optionally
   `tenant_settings.setting_overrides` (per-tenant override), read through the
   typed `SettingsService` (apps/api/src/settings). Adding a setting means a
   seed row plus a registry entry in the same change. Enforced by
   apps/api/src/architecture/no-hardcoded-numbers.spec.ts.
10. Discovery is always radius-based (PostGIS distance from the viewer).
    Tenant boundaries decide ownership (who operates / moderates / earns),
    never visibility. Never filter a feed, search or map by `tenant_id` alone.
11. Legal holds: every purge / scrub / anonymize path must check
    `legal_hold_blocks(subject_type, subject_id)` (table `legal_holds`) first
    and refuse if it returns true.
12. Status vs deletion: `sold`, `expired`, `removed` are values of
    `status_code` (lookup `post_statuses`). `deletion_reason_code` (lookup
    `post_deletion_reasons`) is only one of: `user_deleted`,
    `moderator_removed`, `tenant_terminated`, `spam_auto`, `legal_hold`.
    Never mix the two.
13. Moderation audit: every takedown writes a `moderation_actions` row with a
    reason in the same transaction as the status change.

## Conventions

- Naming: snake_case in DB, camelCase in TS, kebab-case for files
- Modules: NestJS feature modules; business logic in services, not controllers
- IDs: uuid v7 (time-sortable) via `uuid_generate_v7()` helper
- Timestamps: `timestamptz`, always UTC, `created_at`/`updated_at` on every table
- Soft delete: `deleted_at timestamptz` where history matters
- Commits: conventional commits (feat/fix/chore/refactor/test/docs)

## Testing

- Unit tests for services, integration tests for controllers
- Every RLS policy needs a test proving cross-tenant access is blocked
- Use a separate test database, never the dev one

## What NOT to do

- Do not add new dependencies without asking first
- Do not modify files outside the module you were asked to work on
- Do not write migrations that drop or rename columns without flagging it
- Do not scaffold features that were not requested

## Current Phase

Month 2 (weeks 5–9) — Core marketplace: posts, feed, search UX, map.

- Schema is complete (migrations 0001–0021). It changes only through new
  migrations, never by editing an existing one.
- Boost RANKING hooks may exist (a boosted post ranks higher), but there is
  no purchase flow.
- Do NOT build yet (months 3–5): payments, credit purchase, boost purchase,
  subscriptions, chat, reviews, admin dashboards beyond the moderation queue.

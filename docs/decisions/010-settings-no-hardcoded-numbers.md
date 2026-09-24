# ADR 010: No hardcoded numbers. Every behavioural number lives in `platform_settings`

**Status:** Accepted (Q40), now CLAUDE.md hard rule 9
**Date:** 2026-09-17
**Schema:** [§2.16 `platform_settings`](../specs/schema.md), [§2.4 `tenant_settings.setting_overrides`](../specs/schema.md), [§13.34](../specs/schema.md)
**Code:** `apps/api/src/settings/`, `apps/api/src/architecture/no-hardcoded-numbers.spec.ts`

## Context

The spec had accumulated fixed numbers: media purge 30 days, appeal escalation 7 days, ban ladder 7/30
days, notice offsets, saved-search limits and more. Some sat in columns, some in prose, some would have
ended up as constants in services. Every one of them is a business decision that operations will want to
change without a deploy, and that some partners may need differently.

## Decision

1. **Rule:** no duration, limit, threshold or price is hardcoded in application code. If a number governs
   behaviour, it lives in `platform_settings` (global default) and optionally in
   `tenant_settings.setting_overrides` (per-tenant override).
2. **Storage: key-value, not a wide singleton row.** `platform_settings(key, value jsonb, value_type, unit,
min_value, max_value, tenant_override_scope, description)`. Adding a setting = a seed row + a registry
   entry, with no column migration. The earlier singleton columns and `tenant_billing` override columns are replaced.
3. **Override scope per key:** `none`, `platform` (staff set per-tenant), or `tenant_admin` (the partner may
   set it). A trigger validates key, type, bounds and who is changing it.
4. **Keys added:** all of those listed in Q40 (with `boost_voucher_validity_days` from ADR 011), plus ones found
   hardcoded in the spec: `free_posts_per_month`, `boundary_buffer_km`,
   `lead_dedupe_minutes`, `outbox_processed_retention_days`, `activity_log_retention_days`,
   `lead_event_retention_months`, `export_link_validity_days`, `appeal_max_attachments`.
5. **API access: typed `SettingsService`.**
   - A zod registry types every key: `get('grace_past_due_days', tenantId)` returns a `number`.
   - Cache for `SETTINGS_CACHE_TTL_MS`, with one shared load per key for concurrent callers.
   - Invalidation is local plus cluster-wide via Redis pub/sub (`settings:invalidate`). A load that started
     before an invalidation can't repopulate the cache.
   - **No defaults in code:** a missing key or wrong type throws a typed exception.
   - If Redis is unavailable at boot, the service still works, bounded by the TTL.
6. **Later additions:** `continuity_subsidy_max_bdt_per_month` and `continuity_subsidy_platform_max_bdt_per_month` (ADR 007),
   `credit_refund_sla_days` and `refund_manual_verification_threshold_bdt` (ADR 014), a `money` value type stored as a two-decimal
   JSON string, never a JSON number. `scrub_location_decimals` was removed when scrubs stopped keeping coordinates (ADR 006).
7. **Enforcement test:** parses all API source with the TypeScript compiler and fails on numeric literals other
   than 0/1 outside an explicit, commented allow-list of infrastructure paths (`config/`, `health/`, `common/`,
   `main.ts`), or lines marked `// settings-exempt: <reason>`.

## Reasoning

- **Key-value over typed columns:** there are 30+ settings and more will come. Columns would mean a migration
  per knob, while key-value with DB-side type and bounds checks keeps safety without that friction. The TS
  registry restores compile-time typing where it matters (call sites).
- **A literal scanner, not a grep:** a regex can't tell `15` in a comment or string from code; the TS AST can.
  Allowing 0 and 1 covers indexing, increments and booleans-as-numbers without noise.
- **Infrastructure exemptions** (ports, probe timeouts, HTTP status codes) are explicit and each has a reason, so
  widening them is a reviewed change.
- **Cache TTL and source timeout** are env vars, not settings: they configure the settings mechanism itself, so
  reading them from settings would be circular.

## Consequences

- DB CHECK bounds that are pure sanity limits stay in DDL; the governing limit is the setting.
- Jobs in SQL use `effective_setting(tenant_id, key)` with the same precedence.
- A PR that introduces a business number must add the key, seed and registry entry together, or the test fails.

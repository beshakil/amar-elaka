## What and why

<!-- What changes, and the reason for it. Link the issue if there is one. -->

## How it was tested

<!-- Commands run, screens checked, anything a reviewer should try. -->

## Checklist

- [ ] **Tests added or updated** for the change (unit for services/helpers, e2e for user-facing flows)
- [ ] **Migration reviewed**: no dropped or renamed columns, or they are called out above with a rollout plan
- [ ] **RLS covered**: every new tenant-scoped table has `tenant_id`, an RLS policy, a seed, and a test proving cross-tenant access is blocked
- [ ] No hardcoded durations, limits, thresholds or prices: they live in `platform_settings` (read via `SettingsService`)
- [ ] No hardcoded user-facing strings: Bengali copy is in the message catalogs
- [ ] API contract changed? `pnpm gen:api` was run and `packages/shared-types/openapi.json` is committed
- [ ] Mobile changed? `build_runner` / `gen-l10n` re-run, and `flutter analyze` is clean
- [ ] A decision worth remembering has an ADR in `docs/decisions/`

<!-- Not applicable? Tick it and say "n/a" next to it rather than deleting the line. -->

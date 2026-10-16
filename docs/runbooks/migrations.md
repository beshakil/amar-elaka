# Migrations

**Last exercised: locally, 2026-10-16** — a fresh database migrated 0000→0062 by the test helper
(`test/db/test-database.ts` `resetAndMigrate()`), several times; then the full DB and e2e suites. **Never on a server**:
there is no production migrate command (see [deploy-coolify.md](deploy-coolify.md), blocker 1).

- Files: `infra/migrations/NNNN_name.sql`, with a `meta/_journal.json` entry and `meta/NNNN_snapshot.json`.
- Order: `0000`–`0002` as a superuser (extensions, roles, RLS helpers), everything after as `ae_migrator`. Functions
  owned by `ae_rls_bypass` are replaced inside `SET LOCAL ROLE ae_rls_bypass … RESET ROLE`.
- **No down-migrations.** Rules: never drop or rename a column without flagging it; write additive migrations that
  the previous release can run against. A bad migration is fixed by a new forward migration, after restoring the
  backup if data was damaged ([rollback.md](rollback.md)).
- After migrating: `scripts/audit-schema.sql` must return no rows for any check (the DB suite runs it).

Locally:

```sh
cd apps/api && source ~/.cache/amar-verify/test.env
npx tsx -e "import('./test/db/test-database').then(db=>db.resetAndMigrate())"
```

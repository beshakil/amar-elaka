# Rollback

**Last exercised: never.**

- **App code:** redeploy the previous image tag in Coolify (api, worker, web, admin). Because migrations are additive,
  the previous release runs against the newer schema.
- **A migration damaged data:** stop writes (scale api and worker to 0), restore the last backup
  ([backup-restore.md](backup-restore.md)) into a new database, compare, then switch `DATABASE_URL` or copy back the
  affected tables. Fix forward with a new migration. There are no down-migrations.
- **A bad base map:** `current.json` points at the previous archive (kept by the build script): edit it back.
- After any rollback: storage check, search reindex if documents changed, and a sign-in smoke test.

# Deploy on Coolify (first deploy and releases)

**Last exercised: never.** It can't be, yet: three blockers stand (checked 2026-10-16).

1. **The API image can't migrate.** `apps/api/Dockerfile` copies `dist`, `assets` and `node_modules`, not
   `infra/migrations`. `db:migrate` is `drizzle-kit migrate`, a dev CLI. There is no release command.
2. **`apps/web` and `apps/admin` have no Dockerfile**, and CI builds no image at all, so nobody knows whether the API
   image still builds.
3. **No SMS account.** In production the API refuses to start on the logging SMS provider (ADR 053), so nobody can sign
   in until BulkSMSBD's account, sender ID and IP whitelist exist.

## The intended procedure (from ADR 028 / 043 / 053)

Resources on the one Contabo VPS, all in one Coolify project:

| Resource                                      | Image / command                                | Volume                                                           |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| api                                           | `apps/api` image, `node apps/api/dist/main.js` | `amar-elaka-storage` → `/app/storage` (photos, documents, tiles) |
| worker                                        | same image, `node apps/api/dist/worker.js`     | the same volume (it writes variants and offline maps)            |
| web, admin                                    | (images to build)                              | —                                                                |
| postgres 16 + postgis, redis, meilisearch 1.8 | Coolify services                               | their own volumes                                                |

Release steps:

1. Back up first: [backup-restore.md](backup-restore.md) §1.
2. Migrate (once a command exists): run it **before** the new API starts. Migrations are additive (no drops or renames
   without a flag), so the old API keeps working against the new schema during the rollout.
3. Deploy worker, then API, then web and admin.
4. Smoke: `GET /health/ready`; `node apps/api/dist/storage/cli/storage-check.js --origin https://<area>.amarelaka.com`
   (every line PASS); sign in with a real SMS; open the map (tiles served); post with a photo and see it approved.
5. Set explicitly on api and worker: `MAP_TILES_PATH=/app/storage/map` (the default is relative to the working
   directory).

Env: every key in `apps/api/src/config/env.schema.ts`; secrets in Coolify's secret store, never in the repo.

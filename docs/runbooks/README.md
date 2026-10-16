# Runbooks

Operational procedures for Amar Elaka. Each runbook says when it was last **exercised** — actually run end to end —
and where. "Locally" means the dev laptop's test stack (Postgres 16 + PostGIS, Redis, Meilisearch; see
`local-test-stack` notes), not a server. Nothing has been exercised on a server: as of 2026-10-16 there is no staging or
production deployment of this codebase (see `docs/status/month-3-review.md` §13).

| Runbook                                            | Covers                                                   | Last exercised                         |
| -------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| [deploy-coolify.md](deploy-coolify.md)             | First deploy and every release on the Coolify VPS        | **Never** — blocked (see the runbook)  |
| [migrations.md](migrations.md)                     | Applying migrations; why there is no down-migration      | Locally, 2026-10-16 (test helper)      |
| [backup-restore.md](backup-restore.md)             | Postgres, the storage volume, tiles; restore and verify  | Locally, 2026-10-16                    |
| [search-reindex.md](search-reindex.md)             | Rebuilding the Meilisearch indexes from Postgres         | Locally, 2026-10-16                    |
| [storage-check.md](storage-check.md)               | Proving uploads, public media and private documents work | Locally, 2026-10-16                    |
| [base-map.md](base-map.md)                         | Building and publishing the Bangladesh `.pmtiles`        | Locally, 2026-10-05                    |
| [secrets-rotation.md](secrets-rotation.md)         | JWT, NID pepper, provider keys                           | **Never**                              |
| [provider-incidents.md](provider-incidents.md)     | SMS gateway down, Barikoi over budget, push failing      | **Never** (behaviour covered by tests) |
| [legal-holds-and-data.md](legal-holds-and-data.md) | Legal holds, scrubs, account data requests               | **Never** (no API; SQL only)           |
| [rollback.md](rollback.md)                         | Rolling a bad release back                               | **Never**                              |

When you exercise one, update its "Last exercised" line and this table in the same commit.

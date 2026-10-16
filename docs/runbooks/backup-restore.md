# Backup and restore

**Last exercised: locally, 2026-10-16.** A seeded database (213 MB on disk, mostly reference geography) dumped to a
3.1 MB custom-format file and restored into a new database in **9 s**; row counts of posts, places, users and agent
submissions and all **823 RLS policies** matched. **Never on a server; no backup is scheduled anywhere.**

What must be backed up — the VPS has one disk, and each of these is the only copy:

| What               | Where                                   | How                                           | Losing it means                    |
| ------------------ | --------------------------------------- | --------------------------------------------- | ---------------------------------- |
| Postgres           | its Coolify volume                      | `pg_dump -Fc` nightly, kept 14 days, off-site | everything                         |
| Storage volume     | `/app/storage` (`media/`, `documents/`) | `restic`/`rclone` nightly, off-site           | every photo; verification evidence |
| Base map           | `/app/storage/map`                      | rebuildable ([base-map.md](base-map.md))      | the map until rebuilt (~minutes)   |
| Meilisearch, Redis | their volumes                           | **not** backed up: rebuildable                | search until reindexed; sessions   |

## 1. Back up

```sh
pg_dump -h <host> -U <superuser> -Fc -d amar_elaka -f amar_elaka-$(date +%F).dump
restic -r <off-site repo> backup /app/storage --exclude '/app/storage/map'
```

## 2. Restore and verify

```sh
createdb amar_elaka_restore
pg_restore -d amar_elaka_restore --no-owner amar_elaka-<date>.dump   # must report 0 errors
psql -d amar_elaka_restore -c "select count(*) from posts; select count(*) from pg_policies;"
```

- **A clean restore reports zero errors.** The local drill reported 2, both from orphan `place_revisions` rows that test
  cleanups leave in the _test_ template (they delete with triggers off). A production restore with errors means
  orphaned data: stop and look.
- Restore the storage volume, then run [storage-check.md](storage-check.md) and [search-reindex.md](search-reindex.md).
- Documents purged by retention (verification evidence after `verification_doc_retention_days`) come back with an old
  backup: re-run the purge job after a restore (`purge-verification-documents`).

Locally (what was run on 2026-10-16):

```sh
pg_dump -h 127.0.0.1 -p 5433 -U ae_dev -Fc -d ae_sizecheck -f ae.dump
createdb … ae_restorecheck && pg_restore … -d ae_restorecheck --no-owner ae.dump
```

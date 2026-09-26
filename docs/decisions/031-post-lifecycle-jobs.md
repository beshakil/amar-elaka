# ADR 031 — Scheduled post-lifecycle jobs and the jobs health view

**Status:** Accepted (2026-09-26). Code: `apps/api/src/jobs`, `apps/api/src/posts` (expiry, reminder, draft
cleanup), `apps/api/src/media/media-maintenance.service.ts`, migration 0028. Refines ADR 029 (expiry, repost) and
ADR 030 §3 (trust drift).

## Decisions

**1. Five jobs, BullMQ repeatable jobs in the worker process.** They run in the worker (`node dist/worker.js`),
never in the API. `upsertJobScheduler` is idempotent across restarts. Times are Asia/Dhaka.

| Job                     | Queue   | Schedule      | Does                                                                             |
| ----------------------- | ------- | ------------- | -------------------------------------------------------------------------------- |
| `expire-posts`          | `posts` | every 15 min  | live → expired past `expires_at`, with `post.expired`                            |
| `remind-expiring-posts` | `posts` | hourly at :05 | `post_expiring` notification `post_expiry_reminder_days` before expiry           |
| `clean-stale-drafts`    | `posts` | nightly 04:00 | hard-deletes drafts untouched for `draft_retention_days`                         |
| `clean-orphan-media`    | `media` | hourly at :15 | deletes unattached uploads older than `orphan_media_hours`, row and files        |
| `purge-deleted-media`   | `media` | nightly 03:30 | deletes the files of soft-deleted media past `purge_due_at` (`media_purge_days`) |

The cron patterns are ops tuning, marked `settings-exempt`. Every number that decides _what_ a job acts on is a setting.

**2. One `JobRunner` for every job.** A scheduled run and a manual run take the same path:

- **One run at a time.** A partial unique index on `job_runs (job_code) WHERE status_code = 'running'` means a second
  start (a manual trigger during the scheduled run, a second worker replica) is recorded as `skipped` and does
  nothing. A run still `running` after `job_run_stale_minutes` (its worker died) is closed as failed and stops
  blocking.
- **Batches with a cap.** `job_batch_size` rows per transaction, at most `job_max_batches_per_run` transactions per
  run. A run that stops at the cap says so (`details.capped`), and the next run carries on. These replace the
  hardcoded, `settings-exempt` batch constants the sweeps had.
- **Logs and a record.** Start and end are logged (`job`, `runId`, `trigger`, `rows`, `capped`, `durationMs`), and every
  run is a `job_runs` row. A failure is recorded as `Class: message` (the stack stays in the logs), then rethrown so
  BullMQ's retries and the dead-letter queue work as before.
- **Idempotent work.** Each job selects only rows still due (`status = 'live' AND expires_at <= now()`,
  `purged_at IS NULL`, …) with `FOR UPDATE SKIP LOCKED`, in a **locking CTE**. `WHERE id IN (SELECT … LIMIT n)` is
  not used: the planner may re-run that subquery and exceed the limit. The e2e cap test caught this in the existing
  orphan sweep.

**3. Legal holds on everything destructive.** Draft cleanup, orphan media and media purge all skip
`legal_hold_blocks(...)` subjects, including holds on the author or uploader. Expiry and reminders destroy nothing.

**4. Expiry reminder + one-tap repost.**

- `posts.expiry_reminder_for` stores the `expires_at` the owner was reminded about, so there is one reminder per
  listing period. A repost sets a new `expires_at`, which makes the post due again later.
- Send, then mark. The post is marked only once a channel delivered (`NotificationService.send` now returns
  `{ delivered }`). A crash in between resends, and the dedupe key (`post_expiring:<id>:<expires_at>`) keeps it to one.
- Hidden posts aren't reminded.
- `POST /posts/:id/repost` is the one tap. On an expired post it does what it did before: expired → live, bumped. On a
  live post inside the reminder window it now **renews**: a fresh `expires_at` from now, same status, **not bumped**
  (a renewal is not a boost), `post.renewed`. Earlier than the window → 409 `POST_RENEW_TOO_EARLY` with
  `renewableFrom`.

**5. Stale drafts are hard-deleted.** A draft was never published and has no history. `deletion_reason_code` (hard
rule 12) has no honest value for it, so soft delete would mean adding a new code. Instead:

- `posts` gets `DELETE`, narrowed by a **RESTRICTIVE** policy: only `app.role = 'system'`, only `status = 'draft'`,
  never under a legal hold. Every other role and status still can't hard-delete a post
  (`rls-content.db-spec`, `lifecycle-jobs.db-spec`).
- A draft something still references (report, saved post, lead…) is left alone instead of failing its batch on a
  RESTRICT foreign key.
- Attachments go with the draft (CASCADE). The photos then become orphans, and `clean-orphan-media` removes them with
  their files.

**6. Orphan media: row and files in one transaction.** Before, the rows were deleted and committed, then the files
deleted. A storage failure then left files with no row pointing at them, never cleaned. Now it is: delete the rows,
delete the files, commit. A storage failure rolls back, and the next run retries. A concurrent attach waits on the row
lock, then fails.

**7. Trust drift stays event-driven.** Nothing about trust runs on a schedule. The one time-based input, account age,
is covered this way:

- Each recompute saves `next_recompute_at` = the next 30-day account-age step (`nextAccountAgeStep`), until the age
  points reach their cap.
- The first `get()` after that instant recomputes.
- An idle member's score still grows with age, with no cron.

**8. Platform admin API** (`platform_admin` only; the write is audited):

- `GET /platform/jobs`: per job, the schedule and next run (from BullMQ), whether it is running, the last run, the
  last success and the last failure.
- `GET /platform/jobs/:code/runs`: the latest `job_runs_page_size` runs.
- `POST /platform/jobs/:code/run`: 202 with the BullMQ job id. The run happens in the worker, and the history shows it
  as `manual` with the admin's id.

There is no admin page yet: Month 2 builds no dashboards beyond the moderation queue. The API is the view.

## Consequences

- New settings (all `none` scope):
  - `post_expiry_reminder_days`, `draft_retention_days`
  - `job_batch_size`, `job_max_batches_per_run`
  - `job_run_stale_minutes`, `job_run_retention_days`, `job_runs_page_size`
- `job_runs` prunes itself: every successful run drops finished runs older than `job_run_retention_days`.
- The sweeps are global, so e2e suites assert on their own rows, never on run totals. The posts e2e was adjusted
  accordingly.
- Tests:
  - `job-batches.spec`, trust `nextAccountAgeStep` specs
  - `lifecycle-jobs.db-spec`: `job_runs` RLS, one running run, the hard-delete policy
  - `lifecycle-jobs.e2e-spec`: each job's effect, idempotency, cap and legal hold; reminder once per period and after
    renewal; renew window; runner skip and failure; the platform API end to end through the worker

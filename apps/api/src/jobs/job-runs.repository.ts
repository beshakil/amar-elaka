import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { ScheduledJobCode } from './scheduled-jobs';

export const JOB_RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

const JOB_RUN = z.object({
  id: z.string(),
  job_code: z.string(),
  trigger_code: z.enum(['schedule', 'manual']),
  triggered_by_user_id: z.string().nullable(),
  queue_job_id: z.string().nullable(),
  status_code: z.enum(JOB_RUN_STATUSES),
  started_at: z.coerce.date(),
  finished_at: z.coerce.date().nullable(),
  duration_ms: z.number().nullable(),
  rows_affected: z.number(),
  details: z.record(z.unknown()),
  error_message: z.string().nullable(),
});
export type JobRunRow = z.infer<typeof JOB_RUN>;

const RUN_COLUMNS = sql`id, job_code, trigger_code, triggered_by_user_id, queue_job_id, status_code,
  started_at, finished_at, duration_ms, rows_affected, details, error_message`;

export interface RunStart {
  job: ScheduledJobCode;
  trigger: 'schedule' | 'manual';
  triggeredByUserId: string | null;
  queueJobId: string | null;
}

/** job_runs (0028). Written in a system context (JobRunner); read by platform staff. */
@Injectable()
export class JobRunsRepository {
  /**
   * Opens a run, unless one of the same job is already running. A run left
   * `running` longer than `staleMinutes` (its worker died) is closed as
   * failed first, so it never blocks the job for good.
   */
  async start(
    tx: DatabaseTransaction,
    run: RunStart,
    staleMinutes: number,
  ): Promise<string | null> {
    await tx.execute(sql`
      update public.job_runs
      set status_code = 'failed', finished_at = now(),
          duration_ms = (extract(epoch from now() - started_at) * 1000)::int,
          error_message = 'stale: still running after job_run_stale_minutes (worker lost?)'
      where job_code = ${run.job} and status_code = 'running'
        and started_at < now() - make_interval(mins => ${staleMinutes})`);
    const rows = await tx.execute(sql`
      insert into public.job_runs (job_code, trigger_code, triggered_by_user_id, queue_job_id)
      values (${run.job}, ${run.trigger}, ${run.triggeredByUserId}::uuid, ${run.queueJobId})
      on conflict (job_code) where status_code = 'running' do nothing
      returning id`);
    return (
      z
        .array(z.object({ id: z.string() }))
        .max(1)
        .parse([...rows])[0]?.id ?? null
    );
  }

  /** A start that found the job already running: recorded, so the health view shows it. */
  async skipped(tx: DatabaseTransaction, run: RunStart): Promise<void> {
    await tx.execute(sql`
      insert into public.job_runs (job_code, trigger_code, triggered_by_user_id, queue_job_id,
                                   status_code, finished_at, duration_ms, error_message)
      values (${run.job}, ${run.trigger}, ${run.triggeredByUserId}::uuid, ${run.queueJobId},
              'skipped', now(), 0, 'another run of this job was in progress')`);
  }

  async finish(
    tx: DatabaseTransaction,
    id: string,
    result:
      | { status: 'succeeded'; rows: number; details: Record<string, unknown> }
      | { status: 'failed'; rows: number; error: string },
  ): Promise<void> {
    await tx.execute(sql`
      update public.job_runs set
        status_code = ${result.status},
        finished_at = now(),
        duration_ms = (extract(epoch from now() - started_at) * 1000)::int,
        rows_affected = ${result.rows},
        details = ${JSON.stringify(result.status === 'succeeded' ? result.details : {})}::jsonb,
        error_message = ${result.status === 'failed' ? result.error : null}
      where id = ${id}::uuid and status_code = 'running'`);
  }

  /** Drops finished runs older than the retention window. */
  async prune(tx: DatabaseTransaction, retentionDays: number): Promise<number> {
    const rows = await tx.execute(sql`
      delete from public.job_runs
      where status_code <> 'running' and started_at < now() - make_interval(days => ${retentionDays})
      returning id`);
    return [...rows].length;
  }

  // ---- the platform jobs view (platform staff transaction) ------------------

  async latest(
    tx: DatabaseTransaction,
  ): Promise<
    Map<
      string,
      { last: JobRunRow | null; lastSuccessAt: Date | null; lastFailure: JobRunRow | null }
    >
  > {
    const [last, success, failure] = await Promise.all([
      tx.execute(sql`
        select distinct on (job_code) ${RUN_COLUMNS} from public.job_runs
        where status_code <> 'skipped'
        order by job_code, started_at desc`),
      tx.execute(sql`
        select job_code, max(finished_at) as at from public.job_runs
        where status_code = 'succeeded' group by job_code`),
      tx.execute(sql`
        select distinct on (job_code) ${RUN_COLUMNS} from public.job_runs
        where status_code = 'failed'
        order by job_code, started_at desc`),
    ]);
    const lastRuns = z.array(JOB_RUN).parse([...last]);
    const successes = z
      .array(z.object({ job_code: z.string(), at: z.coerce.date() }))
      .parse([...success]);
    const failures = z.array(JOB_RUN).parse([...failure]);
    const byJob = new Map<
      string,
      { last: JobRunRow | null; lastSuccessAt: Date | null; lastFailure: JobRunRow | null }
    >();
    const entry = (code: string) => {
      const found = byJob.get(code) ?? { last: null, lastSuccessAt: null, lastFailure: null };
      byJob.set(code, found);
      return found;
    };
    for (const run of lastRuns) entry(run.job_code).last = run;
    for (const row of successes) entry(row.job_code).lastSuccessAt = row.at;
    for (const run of failures) entry(run.job_code).lastFailure = run;
    return byJob;
  }

  async history(
    tx: DatabaseTransaction,
    job: ScheduledJobCode,
    limit: number,
  ): Promise<JobRunRow[]> {
    const rows = await tx.execute(sql`
      select ${RUN_COLUMNS} from public.job_runs
      where job_code = ${job}
      order by started_at desc
      limit ${limit}`);
    return z.array(JOB_RUN).parse([...rows]);
  }
}

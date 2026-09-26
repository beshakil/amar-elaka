import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { ScheduledJobData } from '../queue/queue.types';
import { SettingsService } from '../settings/settings.service';
import type { JobBudget, JobOutcome } from './job-batches';
import { JobRunsRepository, type RunStart } from './job-runs.repository';
import type { ScheduledJobCode } from './scheduled-jobs';

export type JobRunResult =
  ({ status: 'succeeded'; runId: string } & JobOutcome) | { status: 'skipped'; runId: null };

/**
 * Every scheduled lifecycle job runs through here (ADR 031), whoever started
 * it — the repeatable schedule or a platform admin's manual trigger:
 *
 *  - one run of a job at a time (job_runs' partial unique index); a second
 *    start is recorded as `skipped` and does nothing;
 *  - the budget (job_batch_size × job_max_batches_per_run) comes from settings;
 *  - start and end are logged with the rows affected and the duration, and
 *    recorded in job_runs for the platform jobs view;
 *  - a failure is recorded, then rethrown, so BullMQ retries and, after the
 *    last attempt, dead-letters it as before.
 *
 * The work itself must be idempotent: each job selects only rows still due,
 * so a retry or a second run finds nothing already done.
 */
@Injectable()
export class JobRunner {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly runs: JobRunsRepository,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JobRunner.name);
  }

  async run(
    job: ScheduledJobCode,
    data: ScheduledJobData | undefined,
    queueJobId: string | null,
    work: (budget: JobBudget) => Promise<JobOutcome>,
  ): Promise<JobRunResult> {
    const start: RunStart = {
      job,
      trigger: data?.trigger === 'manual' ? 'manual' : 'schedule',
      triggeredByUserId: data?.triggeredByUserId ?? null,
      queueJobId,
    };
    const [batchSize, maxBatches, staleMinutes, retentionDays] = await Promise.all([
      this.settings.get('job_batch_size'),
      this.settings.get('job_max_batches_per_run'),
      this.settings.get('job_run_stale_minutes'),
      this.settings.get('job_run_retention_days'),
    ]);

    const runId = await this.asSystem((tx) => this.runs.start(tx, start, staleMinutes));
    if (!runId) {
      await this.asSystem((tx) => this.runs.skipped(tx, start));
      this.logger.info({ job, trigger: start.trigger }, 'job skipped: already running');
      return { status: 'skipped', runId: null };
    }

    const startedAt = Date.now();
    this.logger.info({ job, runId, trigger: start.trigger, batchSize, maxBatches }, 'job started');
    let outcome: JobOutcome;
    try {
      outcome = await work({ batchSize, maxBatches });
    } catch (error) {
      await this.asSystem((tx) =>
        this.runs.finish(tx, runId, { status: 'failed', rows: 0, error: describe(error) }),
      );
      this.logger.error(
        { job, runId, durationMs: Date.now() - startedAt, err: error },
        'job failed',
      );
      throw error;
    }

    await this.asSystem(async (tx) => {
      await this.runs.finish(tx, runId, {
        status: 'succeeded',
        rows: outcome.rows,
        details: { capped: outcome.capped, ...outcome.details },
      });
      await this.runs.prune(tx, retentionDays);
    });
    this.logger.info(
      {
        job,
        runId,
        rows: outcome.rows,
        capped: outcome.capped,
        ...outcome.details,
        durationMs: Date.now() - startedAt,
      },
      'job finished',
    );
    return { status: 'succeeded', runId, ...outcome };
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

/** Class and message only: stacks belong in the logs, not in a row platform staff read over the API. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

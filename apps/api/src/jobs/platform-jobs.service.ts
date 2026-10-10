import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import {
  QUEUE_GEO,
  QUEUE_PLACES,
  QUEUE_MAP,
  QUEUE_NOTIFICATIONS,
  QUEUE_MEDIA,
  QUEUE_POSTS,
  QUEUE_SAVED_SEARCHES,
  type ScheduledJobData,
} from '../queue/queue.types';
import { SettingsService } from '../settings/settings.service';
import type { JobHealth, JobRun, JobTriggered } from './dto/platform-jobs.dto';
import { JobRunsRepository, type JobRunRow } from './job-runs.repository';
import { SCHEDULED_JOB_CODES, SCHEDULED_JOBS, type ScheduledJobCode } from './scheduled-jobs';

/**
 * The platform jobs view and manual triggers (ADR 031). The API process only
 * reads job_runs and BullMQ's schedulers, and enqueues; every run happens in
 * the worker, through JobRunner — a manual run takes the same path as a
 * scheduled one, lock and all.
 */
@Injectable()
export class PlatformJobsService {
  private readonly queues: Record<string, Queue<ScheduledJobData>>;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly runs: JobRunsRepository,
    private readonly settings: SettingsService,
    @InjectQueue(QUEUE_POSTS) postsQueue: Queue<ScheduledJobData>,
    @InjectQueue(QUEUE_MEDIA) mediaQueue: Queue<ScheduledJobData>,
    @InjectQueue(QUEUE_SAVED_SEARCHES) savedSearchesQueue: Queue<ScheduledJobData>,
    @InjectQueue(QUEUE_GEO) geoQueue: Queue<ScheduledJobData>,
    @InjectQueue(QUEUE_PLACES) placesQueue: Queue<ScheduledJobData>,
    @InjectQueue(QUEUE_MAP) mapQueue: Queue<ScheduledJobData>,
    @InjectQueue(QUEUE_NOTIFICATIONS) notificationsQueue: Queue<ScheduledJobData>,
  ) {
    this.queues = {
      [QUEUE_POSTS]: postsQueue,
      [QUEUE_MEDIA]: mediaQueue,
      [QUEUE_SAVED_SEARCHES]: savedSearchesQueue,
      [QUEUE_GEO]: geoQueue,
      [QUEUE_PLACES]: placesQueue,
      [QUEUE_MAP]: mapQueue,
      [QUEUE_NOTIFICATIONS]: notificationsQueue,
    };
  }

  async health(): Promise<JobHealth[]> {
    const [latest, schedulers] = await Promise.all([
      this.tenantDb.transaction((tx) => this.runs.latest(tx), { accessMode: 'read only' }),
      Promise.all(SCHEDULED_JOB_CODES.map((code) => this.queueOf(code).getJobScheduler(code))),
    ]);
    return SCHEDULED_JOB_CODES.map((code, index) => {
      const runs = latest.get(code);
      const scheduler = schedulers[index];
      return {
        code,
        queue: SCHEDULED_JOBS[code].queue,
        schedule: scheduler
          ? {
              pattern: scheduler.pattern ?? null,
              tz: scheduler.tz ?? null,
              nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
            }
          : null,
        running: runs?.last?.status_code === 'running',
        lastRun: runs?.last ? toRun(runs.last) : null,
        lastSuccessAt: runs?.lastSuccessAt?.toISOString() ?? null,
        lastFailure: runs?.lastFailure ? toRun(runs.lastFailure) : null,
      };
    });
  }

  async history(code: ScheduledJobCode): Promise<JobRun[]> {
    const limit = await this.settings.get('job_runs_page_size');
    const rows = await this.tenantDb.transaction((tx) => this.runs.history(tx, code, limit), {
      accessMode: 'read only',
    });
    return rows.map(toRun);
  }

  /** Enqueues one run now; the worker records it in job_runs as a manual run by this admin. */
  async trigger(code: ScheduledJobCode): Promise<JobTriggered> {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    const job = await this.queueOf(code).add(code, {
      trigger: 'manual',
      triggeredByUserId: userId,
    });
    return { code, queue: SCHEDULED_JOBS[code].queue, queueJobId: job.id ?? '' };
  }

  private queueOf(code: ScheduledJobCode): Queue<ScheduledJobData> {
    return this.queues[SCHEDULED_JOBS[code].queue]!;
  }
}

function toRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    trigger: row.trigger_code,
    triggeredByUserId: row.triggered_by_user_id,
    queueJobId: row.queue_job_id,
    status: row.status_code,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    rowsAffected: row.rows_affected,
    details: row.details,
    error: row.error_message,
  };
}

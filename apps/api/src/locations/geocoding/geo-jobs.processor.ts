import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { JobRunner, type JobRunResult } from '../../jobs/job-runner.service';
import { relayToDeadLetterQueueOnFinalFailure } from '../../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_PURGE_GEO_PROVIDER_CALLS,
  QUEUE_GEO,
  type ScheduledJobData,
} from '../../queue/queue.types';
import { SettingsService } from '../../settings/settings.service';
import { GeoCallLog } from './geo-call-log';

// settings-exempt: cron schedule for a background job (ops tuning); what it acts on is geo_provider_calls_retention_days
const PURGE_SCHEDULE = '45 4 * * *'; // nightly, 04:45 Dhaka time
const SCHEDULE_TIMEZONE = 'Asia/Dhaka';

/** Registers the purge (worker only; idempotent across restarts). */
@Injectable()
export class GeoJobsSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_GEO) private readonly queue: Queue<ScheduledJobData>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_PURGE_GEO_PROVIDER_CALLS,
      { pattern: PURGE_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_PURGE_GEO_PROVIDER_CALLS, data: {} },
    );
  }
}

/**
 * The only processor on the `geo` queue: purge-geo-provider-calls deletes
 * geo_provider_calls rows older than geo_provider_calls_retention_days, in
 * batches within the job budget (JobRunner, ADR 031) — the log grows with
 * traffic now that cache hits are logged too (ADR 044).
 */
@Processor(QUEUE_GEO)
export class GeoJobsProcessor extends WorkerHost {
  constructor(
    private readonly runner: JobRunner,
    private readonly log: GeoCallLog,
    private readonly settings: SettingsService,
    @InjectQueue(deadLetterQueueName(QUEUE_GEO)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(GeoJobsProcessor.name);
  }

  async process(job: Job<ScheduledJobData>): Promise<JobRunResult> {
    if (job.name !== JOB_PURGE_GEO_PROVIDER_CALLS) {
      throw new Error(`geo queue: unknown job ${job.name}`);
    }
    return this.runner.run(
      JOB_PURGE_GEO_PROVIDER_CALLS,
      job.data,
      job.id ?? null,
      async (budget) => {
        const retentionDays = await this.settings.get('geo_provider_calls_retention_days');
        let rows = 0;
        for (let batch = 0; batch < budget.maxBatches; batch++) {
          const deleted = await this.log.purge(retentionDays, budget.batchSize);
          rows += deleted;
          if (deleted < budget.batchSize) return { rows, capped: false };
        }
        return { rows, capped: true };
      },
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'geo job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

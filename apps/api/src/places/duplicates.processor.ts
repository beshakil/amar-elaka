import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { JobRunner, type JobRunResult } from '../jobs/job-runner.service';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_DETECT_DUPLICATES,
  QUEUE_PLACES,
  type ScheduledJobData,
} from '../queue/queue.types';
import { DuplicatesService } from './duplicates.service';
import { SCHEDULE_TIMEZONE } from '../common/schedule-timezone';

// settings-exempt: cron schedule for a background job (ops tuning); what it checks is duplicate_batch_lookback_hours
const DETECT_SCHEDULE = '30 3 * * *'; // nightly, 03:30 Dhaka time

/** Registers the nightly duplicate check (worker only; idempotent across restarts). */
@Injectable()
export class DuplicatesSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_PLACES) private readonly queue: Queue<ScheduledJobData>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_DETECT_DUPLICATES,
      { pattern: DETECT_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_DETECT_DUPLICATES, data: {} },
    );
  }
}

/**
 * The `places` queue: detect-duplicates backfills name_translit and checks
 * places and stores changed recently against their neighbours (ADR 048),
 * within the job budget (JobRunner, ADR 031).
 */
@Processor(QUEUE_PLACES)
export class DuplicatesProcessor extends WorkerHost {
  constructor(
    private readonly runner: JobRunner,
    private readonly duplicates: DuplicatesService,
    @InjectQueue(deadLetterQueueName(QUEUE_PLACES)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(DuplicatesProcessor.name);
  }

  async process(job: Job<ScheduledJobData>): Promise<JobRunResult> {
    if (job.name !== JOB_DETECT_DUPLICATES) {
      throw new Error(`places queue: unknown job ${job.name}`);
    }
    return this.runner.run(JOB_DETECT_DUPLICATES, job.data, job.id ?? null, (budget) =>
      this.duplicates.runBatch(budget),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'places job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

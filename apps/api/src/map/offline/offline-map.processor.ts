import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { JobRunner, type JobRunResult } from '../../jobs/job-runner.service';
import { relayToDeadLetterQueueOnFinalFailure } from '../../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_BUILD_OFFLINE_MAPS,
  QUEUE_MAP,
  type ScheduledJobData,
} from '../../queue/queue.types';
import { OfflineMapBuilder } from './offline-map.builder';
import { SCHEDULE_TIMEZONE } from '../../common/schedule-timezone';

// settings-exempt: cron schedule (ops tuning). Hourly and cheap when nothing changed: a refreshed national archive reaches every tenant within the hour.
const BUILD_SCHEDULE = '20 * * * *';

/** Registers the offline map build (worker only; idempotent across restarts). */
@Injectable()
export class OfflineMapSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_MAP) private readonly queue: Queue<ScheduledJobData>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_BUILD_OFFLINE_MAPS,
      { pattern: BUILD_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_BUILD_OFFLINE_MAPS, data: {} },
    );
  }
}

/** The `map` queue: build-offline-maps (ADR 050), within the job budget (ADR 031). */
@Processor(QUEUE_MAP)
export class OfflineMapProcessor extends WorkerHost {
  constructor(
    private readonly runner: JobRunner,
    private readonly builder: OfflineMapBuilder,
    @InjectQueue(deadLetterQueueName(QUEUE_MAP)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(OfflineMapProcessor.name);
  }

  async process(job: Job<ScheduledJobData>): Promise<JobRunResult> {
    if (job.name !== JOB_BUILD_OFFLINE_MAPS) throw new Error(`map queue: unknown job ${job.name}`);
    return this.runner.run(JOB_BUILD_OFFLINE_MAPS, job.data, job.id ?? null, (budget) =>
      this.builder.run(budget),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'map job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { JobRunner, type JobRunResult } from '../jobs/job-runner.service';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_CLEAN_STALE_DRAFTS,
  JOB_EXPIRE_POSTS,
  JOB_REMIND_EXPIRING_POSTS,
  QUEUE_POSTS,
  type ScheduledJobData,
} from '../queue/queue.types';
import { DraftCleanupService } from './draft-cleanup.service';
import { PostExpiryReminderService } from './post-expiry-reminder.service';
import { PostExpiryService } from './post-expiry.service';

/** The only processor on the `posts` queue; every job is a scheduled lifecycle job run through JobRunner (ADR 031). */
@Processor(QUEUE_POSTS)
export class PostsProcessor extends WorkerHost {
  constructor(
    private readonly runner: JobRunner,
    private readonly expiry: PostExpiryService,
    private readonly reminders: PostExpiryReminderService,
    private readonly drafts: DraftCleanupService,
    @InjectQueue(deadLetterQueueName(QUEUE_POSTS)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(PostsProcessor.name);
  }

  async process(job: Job<ScheduledJobData>): Promise<JobRunResult> {
    const queueJobId = job.id ?? null;
    switch (job.name) {
      case JOB_EXPIRE_POSTS:
        return this.runner.run(JOB_EXPIRE_POSTS, job.data, queueJobId, (budget) =>
          this.expiry.expireDue(budget),
        );
      case JOB_REMIND_EXPIRING_POSTS:
        return this.runner.run(JOB_REMIND_EXPIRING_POSTS, job.data, queueJobId, (budget) =>
          this.reminders.remindExpiring(budget),
        );
      case JOB_CLEAN_STALE_DRAFTS:
        return this.runner.run(JOB_CLEAN_STALE_DRAFTS, job.data, queueJobId, (budget) =>
          this.drafts.cleanStale(budget),
        );
      default:
        throw new Error(`posts queue: unknown job ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'posts job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

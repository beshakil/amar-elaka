import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { UnmetDemandService } from '../analytics/unmet-demand.service';
import { JobRunner, type JobRunResult } from '../jobs/job-runner.service';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_MATCH_SAVED_SEARCHES,
  JOB_PAUSE_IDLE_SAVED_SEARCHES,
  JOB_REFRESH_UNMET_DEMAND,
  QUEUE_SAVED_SEARCHES,
  type ScheduledJobData,
} from '../queue/queue.types';
import { SavedSearchAutoPauseService } from './matching/saved-search-auto-pause.service';
import { SavedSearchMatcherService } from './matching/saved-search-matcher.service';
import { SavedSearchNotifierService } from './matching/saved-search-notifier.service';

/**
 * The only processor on the `saved-searches` queue; every job runs through
 * JobRunner (ADR 031): one run at a time, budget from settings, recorded in
 * job_runs, retried then dead-lettered on failure.
 */
@Processor(QUEUE_SAVED_SEARCHES)
export class SavedSearchesProcessor extends WorkerHost {
  constructor(
    private readonly runner: JobRunner,
    private readonly matcher: SavedSearchMatcherService,
    private readonly notifier: SavedSearchNotifierService,
    private readonly autoPause: SavedSearchAutoPauseService,
    private readonly unmetDemand: UnmetDemandService,
    @InjectQueue(deadLetterQueueName(QUEUE_SAVED_SEARCHES)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(SavedSearchesProcessor.name);
  }

  async process(job: Job<ScheduledJobData>): Promise<JobRunResult> {
    const queueJobId = job.id ?? null;
    switch (job.name) {
      case JOB_MATCH_SAVED_SEARCHES:
        // Match, then notify in the same run: new matches go out without waiting a cycle.
        return this.runner.run(JOB_MATCH_SAVED_SEARCHES, job.data, queueJobId, async (budget) => {
          const matched = await this.matcher.matchNewPosts(budget);
          const notified = await this.notifier.notifyPending(budget);
          return {
            rows: matched.rows,
            capped: matched.capped || notified.capped,
            details: {
              ...matched.details,
              notifications: notified.rows,
              held: notified.details?.held ?? 0,
            },
          };
        });
      case JOB_PAUSE_IDLE_SAVED_SEARCHES:
        return this.runner.run(JOB_PAUSE_IDLE_SAVED_SEARCHES, job.data, queueJobId, (budget) =>
          this.autoPause.pauseIdle(budget),
        );
      case JOB_REFRESH_UNMET_DEMAND:
        return this.runner.run(JOB_REFRESH_UNMET_DEMAND, job.data, queueJobId, () =>
          this.unmetDemand.refresh(),
        );
      default:
        throw new Error(`saved-searches queue: unknown job ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.warn(
      { jobId: job?.id, jobName: job?.name, err: error },
      'saved-searches job failed',
    );
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

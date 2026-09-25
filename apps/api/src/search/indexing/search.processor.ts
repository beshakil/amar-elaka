import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { relayToDeadLetterQueueOnFinalFailure } from '../../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_APPLY_SEARCH_SETTINGS,
  JOB_PURGE_SEARCH_OUTBOX,
  JOB_RELAY_SEARCH_OUTBOX,
  JOB_SWEEP_SEARCH_INDEX,
  QUEUE_SEARCH,
  type SearchJob,
} from '../../queue/queue.types';
import { SearchIndexer } from './search-indexer.service';
import { SearchOutboxRelay } from './search-outbox.relay';

/**
 * The only processor on the `search` queue, dispatching by job name. The
 * relay handles its own failures (per-event backoff in the outbox), so a job
 * only fails when the database itself is unreachable.
 */
@Processor(QUEUE_SEARCH)
export class SearchProcessor extends WorkerHost {
  constructor(
    private readonly relay: SearchOutboxRelay,
    private readonly indexer: SearchIndexer,
    @InjectQueue(deadLetterQueueName(QUEUE_SEARCH)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(SearchProcessor.name);
  }

  async process(job: Job<SearchJob>): Promise<unknown> {
    switch (job.name) {
      case JOB_RELAY_SEARCH_OUTBOX:
        return this.relay.relay();
      case JOB_SWEEP_SEARCH_INDEX:
        return this.indexer.sweep();
      case JOB_PURGE_SEARCH_OUTBOX:
        return this.relay.purgeProcessed();
      case JOB_APPLY_SEARCH_SETTINGS:
        return this.indexer.applySettings();
      default:
        throw new Error(`search queue: unknown job ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SearchJob> | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'search job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

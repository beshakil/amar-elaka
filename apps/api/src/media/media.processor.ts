import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_CLEAN_ORPHAN_MEDIA,
  JOB_PROCESS_MEDIA,
  JOB_PURGE_DELETED_MEDIA,
  QUEUE_MEDIA,
  type ProcessMediaJob,
} from '../queue/queue.types';
import { MediaMaintenanceService } from './media-maintenance.service';
import { MediaProcessingService } from './media-processing.service';

type MediaJob = Job<ProcessMediaJob | Record<string, never>>;

/**
 * The only processor on the `media` queue, dispatching by job name (a second
 * @Processor on the same queue would receive, and drop, the other's jobs).
 * Processing failures that are the file's fault end in `rejected` inside the
 * service and never throw, so only transient errors (storage, database) are
 * retried with the queue's backoff and, after the last attempt, moved to
 * the dead-letter queue.
 */
@Processor(QUEUE_MEDIA)
export class MediaProcessor extends WorkerHost {
  constructor(
    private readonly processing: MediaProcessingService,
    private readonly maintenance: MediaMaintenanceService,
    @InjectQueue(deadLetterQueueName(QUEUE_MEDIA)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(MediaProcessor.name);
  }

  async process(job: MediaJob): Promise<unknown> {
    switch (job.name) {
      case JOB_PROCESS_MEDIA: {
        const { tenantId, mediaAssetId } = job.data as ProcessMediaJob;
        return this.processing.process(tenantId, mediaAssetId);
      }
      case JOB_CLEAN_ORPHAN_MEDIA:
        return this.maintenance.cleanOrphans();
      case JOB_PURGE_DELETED_MEDIA:
        return this.maintenance.purgeDeleted();
      default:
        throw new Error(`media queue: unknown job ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: MediaJob | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, jobName: job?.name, err: error }, 'media job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

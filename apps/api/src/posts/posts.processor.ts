import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import { deadLetterQueueName, JOB_EXPIRE_POSTS, QUEUE_POSTS } from '../queue/queue.types';
import { PostExpiryService } from './post-expiry.service';

/** The only processor on the `posts` queue. */
@Processor(QUEUE_POSTS)
export class PostsProcessor extends WorkerHost {
  constructor(
    private readonly expiry: PostExpiryService,
    @InjectQueue(deadLetterQueueName(QUEUE_POSTS)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(PostsProcessor.name);
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_EXPIRE_POSTS:
        return this.expiry.expireDue();
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

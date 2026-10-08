import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { relayToDeadLetterQueueOnFinalFailure } from '../../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_RUN_STORE_IMPORT,
  QUEUE_IMPORTS,
  type StoreImportJob,
} from '../../queue/queue.types';
import { StoreImportRunner } from './store-import-runner.service';

/** The `imports` queue's processor (ADR 056): one store import per job. */
@Processor(QUEUE_IMPORTS)
export class StoreImportProcessor extends WorkerHost {
  constructor(
    private readonly runner: StoreImportRunner,
    @InjectQueue(deadLetterQueueName(QUEUE_IMPORTS)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(StoreImportProcessor.name);
  }

  async process(job: Job<StoreImportJob>): Promise<void> {
    if (job.name !== JOB_RUN_STORE_IMPORT)
      throw new Error(`imports queue: unknown job ${job.name}`);
    await this.runner.run(job.data.tenantId, job.data.importId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, err: error }, 'store import job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

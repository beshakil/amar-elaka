import { Injectable } from '@nestjs/common';
import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { PinoLogger } from 'nestjs-pino';
import { QUEUE_MAIL } from './queue.types';

@Injectable()
@QueueEventsListener(QUEUE_MAIL)
export class MailQueueEventsListener extends QueueEventsHost {
  constructor(private readonly logger: PinoLogger) {
    super();
    this.logger.setContext(MailQueueEventsListener.name);
  }

  @OnQueueEvent('completed')
  onCompleted({ jobId }: { jobId: string }): void {
    this.logger.info({ jobId }, 'job completed');
  }

  @OnQueueEvent('failed')
  onFailed({ jobId, failedReason }: { jobId: string; failedReason: string }): void {
    this.logger.warn({ jobId, failedReason }, 'job failed');
  }

  @OnQueueEvent('stalled')
  onStalled({ jobId }: { jobId: string }): void {
    this.logger.warn({ jobId }, 'job stalled');
  }
}

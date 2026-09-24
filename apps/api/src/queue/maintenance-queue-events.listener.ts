import { Injectable } from '@nestjs/common';
import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { PinoLogger } from 'nestjs-pino';
import { QUEUE_MAINTENANCE } from './queue.types';

@Injectable()
@QueueEventsListener(QUEUE_MAINTENANCE)
export class MaintenanceQueueEventsListener extends QueueEventsHost {
  constructor(private readonly logger: PinoLogger) {
    super();
    this.logger.setContext(MaintenanceQueueEventsListener.name);
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

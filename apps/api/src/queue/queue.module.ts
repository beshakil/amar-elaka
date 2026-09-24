import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { MailQueueEventsListener } from './mail-queue-events.listener';
import { MaintenanceQueueEventsListener } from './maintenance-queue-events.listener';
import { deadLetterQueueName, QUEUE_MAIL, QUEUE_MAINTENANCE } from './queue.types';

// settings-exempt: queue reliability tuning (retry count/backoff curve), not a business rule
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
} as const;

/**
 * Global so any module can `@InjectQueue(QUEUE_MAIL)` etc. without also
 * calling `BullModule.registerQueue()` itself — the connection and every
 * queue (plus its dead-letter sibling) are registered once, here.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => ({
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_MAIL, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_MAIL) },
      { name: QUEUE_MAINTENANCE, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_MAINTENANCE) },
    ),
  ],
  providers: [MailQueueEventsListener, MaintenanceQueueEventsListener],
  exports: [BullModule],
})
export class QueueModule {}

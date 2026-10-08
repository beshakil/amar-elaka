import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { MailQueueEventsListener } from './mail-queue-events.listener';
import { MaintenanceQueueEventsListener } from './maintenance-queue-events.listener';
import {
  deadLetterQueueName,
  QUEUE_GEO,
  QUEUE_PLACES,
  QUEUE_MAP,
  QUEUE_IMPORTS,
  QUEUE_MAIL,
  QUEUE_MAINTENANCE,
  QUEUE_MEDIA,
  QUEUE_POSTS,
  QUEUE_SAVED_SEARCHES,
  QUEUE_SEARCH,
} from './queue.types';

// Queue reliability tuning (retry count/backoff curve), not business rules.
const DEFAULT_JOB_OPTIONS = {
  // settings-exempt: queue reliability tuning (retry count), not a business rule
  attempts: 5,
  // settings-exempt: queue reliability tuning (backoff curve), not a business rule
  backoff: { type: 'exponential', delay: 5_000 },
} as const;

/**
 * The search relay runs every few seconds: keeping every finished run would
 * grow Redis by tens of thousands of jobs a day, so they're dropped once done
 * (failures keep a short history for debugging).
 */
const SEARCH_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  removeOnComplete: true,
  // settings-exempt: failed-job history kept in Redis for debugging (ops tuning)
  removeOnFail: 100,
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
      { name: QUEUE_MEDIA, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_MEDIA) },
      { name: QUEUE_SEARCH, defaultJobOptions: SEARCH_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_SEARCH) },
      { name: QUEUE_POSTS, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_POSTS) },
      { name: QUEUE_SAVED_SEARCHES, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_SAVED_SEARCHES) },
      { name: QUEUE_GEO, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_GEO) },
      { name: QUEUE_PLACES, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_PLACES) },
      { name: QUEUE_MAP, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_MAP) },
      { name: QUEUE_IMPORTS, defaultJobOptions: DEFAULT_JOB_OPTIONS },
      { name: deadLetterQueueName(QUEUE_IMPORTS) },
    ),
  ],
  providers: [MailQueueEventsListener, MaintenanceQueueEventsListener],
  exports: [BullModule],
})
export class QueueModule {}

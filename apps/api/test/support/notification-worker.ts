import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import type { OutgoingNotification } from '../../src/notifications/notification-channel';
import { NotificationDispatcher } from '../../src/notifications/notification-dispatcher';
import { NotificationsProcessor } from '../../src/notifications/notifications.processor';
import { NotificationsSchedule } from '../../src/notifications/notifications.schedule';
import { NotificationsWorkerModule } from '../../src/notifications/notifications-worker.module';
import { QueueModule } from '../../src/queue/queue.module';
import { JOB_NOTIFY, QUEUE_NOTIFICATIONS } from '../../src/queue/queue.types';

/**
 * Notifications are queued (ADR 059): an action writes no inbox row until
 * the worker dispatches its `notify` job. Specs that check what an action
 * notified boot this — the real dispatcher, without the queue's consumer or
 * its schedules — and call `dispatch` before they look, so each test runs
 * exactly the pipeline production runs, one step at a time.
 */
export interface NotificationWorker {
  /** Dispatches (and removes) the queued notify jobs that match; how many. */
  dispatch(match: (n: OutgoingNotification) => boolean): Promise<number>;
  close(): Promise<void>;
}

export async function startNotificationWorker(): Promise<NotificationWorker> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule,
      DatabaseModule,
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      QueueModule,
      NotificationsWorkerModule,
    ],
  })
    .overrideProvider(NotificationsProcessor)
    .useValue({})
    .overrideProvider(NotificationsSchedule)
    .useValue({})
    .compile();
  await moduleRef.init();
  // Jobs from an earlier run (fixture ids are reused) are left over in Redis:
  // only what this run queued is dispatched; older matches are dropped.
  const startedAt = Date.now();
  const dispatcher = moduleRef.get(NotificationDispatcher);
  const queue = moduleRef.get<Queue<OutgoingNotification>>(getQueueToken(QUEUE_NOTIFICATIONS));

  return {
    async dispatch(match) {
      const matching = (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).filter(
        (job) => job.name === JOB_NOTIFY && match(job.data),
      );
      const stale = matching.filter((job) => job.timestamp < startedAt);
      await Promise.all(stale.map((job) => job.remove()));
      const jobs = matching
        .filter((job) => job.timestamp >= startedAt)
        .sort((a, b) => a.timestamp - b.timestamp);
      for (const job of jobs) {
        await dispatcher.dispatch(job.data);
        await job.remove();
      }
      return jobs.length;
    },
    async close() {
      await moduleRef.close();
    },
  };
}

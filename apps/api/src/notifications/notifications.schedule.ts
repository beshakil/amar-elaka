import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { SCHEDULE_TIMEZONE } from '../common/schedule-timezone';
import {
  JOB_RELAY_NOTIFICATION_OUTBOX,
  QUEUE_NOTIFICATIONS,
  type ScheduledJobData,
} from '../queue/queue.types';

// settings-exempt: cron schedule for a background job (ops tuning); what it acts on is the outbox
const SCHEDULES = {
  [JOB_RELAY_NOTIFICATION_OUTBOX]: '* * * * *', // every minute: a price drop reaches savers within a minute or two
} as const;

/** Registers the notification jobs (worker only; idempotent across restarts). */
@Injectable()
export class NotificationsSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_NOTIFICATIONS) private readonly queue: Queue<ScheduledJobData>) {}

  async onModuleInit(): Promise<void> {
    for (const [name, pattern] of Object.entries(SCHEDULES)) {
      await this.queue.upsertJobScheduler(
        name,
        { pattern, tz: SCHEDULE_TIMEZONE },
        { name, data: {} },
      );
    }
  }
}

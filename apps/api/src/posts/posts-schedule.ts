import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_CLEAN_STALE_DRAFTS,
  JOB_EXPIRE_POSTS,
  JOB_REMIND_EXPIRING_POSTS,
  QUEUE_POSTS,
  type ScheduledJobData,
} from '../queue/queue.types';

// settings-exempt: cron schedules for background sweeps (ops tuning); what they act on is settings (post_expiry_days_default, post_expiry_reminder_days, draft_retention_days)
const SCHEDULES = {
  [JOB_EXPIRE_POSTS]: '*/15 * * * *', // every 15 minutes
  [JOB_REMIND_EXPIRING_POSTS]: '5 * * * *', // hourly, at :05
  [JOB_CLEAN_STALE_DRAFTS]: '0 4 * * *', // nightly, 04:00 Dhaka time
} as const;
const SCHEDULE_TIMEZONE = 'Asia/Dhaka';

/** Registers the repeatable post-lifecycle jobs (worker only; idempotent across restarts). */
@Injectable()
export class PostsSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_POSTS) private readonly queue: Queue<ScheduledJobData>) {}

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

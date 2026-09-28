import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_MATCH_SAVED_SEARCHES,
  JOB_PAUSE_IDLE_SAVED_SEARCHES,
  JOB_REFRESH_UNMET_DEMAND,
  QUEUE_SAVED_SEARCHES,
  type ScheduledJobData,
} from '../queue/queue.types';

// settings-exempt: cron schedules for background jobs (ops tuning); what they act on is settings (saved_search_match_grace_seconds, saved_search_notify_per_day, saved_search_daily_digest_hour, saved_search_auto_pause_days, unmet_demand_*)
const SCHEDULES = {
  [JOB_MATCH_SAVED_SEARCHES]: '*/5 * * * *', // every 5 minutes: "instant" alerts lag a post by ≤ 5 min + grace
  [JOB_PAUSE_IDLE_SAVED_SEARCHES]: '30 3 * * *', // nightly, 03:30 Dhaka time
  [JOB_REFRESH_UNMET_DEMAND]: '15 * * * *', // hourly, at :15
} as const;
const SCHEDULE_TIMEZONE = 'Asia/Dhaka';

/** Registers the saved-search and unmet-demand jobs (worker only; idempotent across restarts). */
@Injectable()
export class SavedSearchesSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_SAVED_SEARCHES) private readonly queue: Queue<ScheduledJobData>) {}

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

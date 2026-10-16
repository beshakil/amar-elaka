import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { SCHEDULE_TIMEZONE } from '../common/schedule-timezone';
import {
  JOB_RELAY_NOTIFICATION_OUTBOX,
  JOB_SEND_REVIEW_PROMPTS,
  JOB_EXPIRE_VERIFICATIONS,
  JOB_PURGE_VERIFICATION_DOCUMENTS,
  JOB_EXPIRE_BANS,
  JOB_ESCALATE_APPEALS,
  JOB_COMPLAINT_SLA,
  JOB_EXPIRE_BLOOD_REQUESTS,
  JOB_ALERT_BLOOD_DONORS,
  JOB_EXPIRE_INFO_ITEMS,
  QUEUE_NOTIFICATIONS,
  type ScheduledJobData,
} from '../queue/queue.types';

// settings-exempt: cron schedule for a background job (ops tuning); what it acts on is the outbox
const SCHEDULES = {
  [JOB_RELAY_NOTIFICATION_OUTBOX]: '* * * * *', // every minute: a price drop reaches savers within a minute or two
  [JOB_SEND_REVIEW_PROMPTS]: '*/15 * * * *', // every 15 minutes: "how was it?" lands near review_prompt_hours
  [JOB_EXPIRE_VERIFICATIONS]: '5 * * * *', // hourly: an expired badge goes within the hour (ADR 062)
  [JOB_PURGE_VERIFICATION_DOCUMENTS]: '40 3 * * *', // nightly: retention of verification documents
  [JOB_EXPIRE_BANS]: '*/10 * * * *', // every 10 minutes: tidies ended bans (they stop biting at once regardless) (ADR 063)
  [JOB_ESCALATE_APPEALS]: '20 * * * *', // hourly: an area that didn't decide in time loses the appeal to the platform
  [JOB_COMPLAINT_SLA]: '*/15 * * * *', // every 15 minutes: overdue complaints are flagged near their due time
  [JOB_EXPIRE_BLOOD_REQUESTS]: '*/15 * * * *', // every 15 minutes: a request closes near its grace end (ADR 064)
  [JOB_ALERT_BLOOD_DONORS]: '*/5 * * * *', // every 5 minutes: a request the API couldn't match still reaches donors
  [JOB_EXPIRE_INFO_ITEMS]: '*/10 * * * *', // every 10 minutes: notices, lost & found and outages end near their time (ADR 065)
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

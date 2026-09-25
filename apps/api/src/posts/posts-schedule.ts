import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JOB_EXPIRE_POSTS, QUEUE_POSTS } from '../queue/queue.types';

// settings-exempt: cron schedule for the expiry sweep (ops tuning); the listing period itself is per category / post_expiry_days_default
const EXPIRY_SCHEDULE = '*/15 * * * *'; // every 15 minutes
const SCHEDULE_TIMEZONE = 'Asia/Dhaka';

/** Registers the repeatable expiry sweep (worker only; idempotent across restarts). */
@Injectable()
export class PostsSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_POSTS) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_EXPIRE_POSTS,
      { pattern: EXPIRY_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_EXPIRE_POSTS, data: {} },
    );
  }
}

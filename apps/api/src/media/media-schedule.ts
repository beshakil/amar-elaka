import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_CLEAN_ORPHAN_MEDIA,
  JOB_PURGE_DELETED_MEDIA,
  QUEUE_MEDIA,
  type MediaSweepJob,
} from '../queue/queue.types';

// settings-exempt: cron schedules for background sweeps (ops tuning); the 24h orphan age itself is the orphan_media_hours setting
const ORPHAN_SWEEP_SCHEDULE = '15 * * * *'; // hourly, at :15
// settings-exempt: see above
const PURGE_SCHEDULE = '30 3 * * *'; // nightly, 03:30 Dhaka time
const SCHEDULE_TIMEZONE = 'Asia/Dhaka';

/** Registers the repeatable media sweeps (worker only; idempotent across restarts). */
@Injectable()
export class MediaSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_MEDIA) private readonly queue: Queue<MediaSweepJob>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_CLEAN_ORPHAN_MEDIA,
      { pattern: ORPHAN_SWEEP_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_CLEAN_ORPHAN_MEDIA, data: {} },
    );
    await this.queue.upsertJobScheduler(
      JOB_PURGE_DELETED_MEDIA,
      { pattern: PURGE_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_PURGE_DELETED_MEDIA, data: {} },
    );
  }
}

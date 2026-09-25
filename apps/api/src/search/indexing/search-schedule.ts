import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_APPLY_SEARCH_SETTINGS,
  JOB_PURGE_SEARCH_OUTBOX,
  JOB_RELAY_SEARCH_OUTBOX,
  JOB_SWEEP_SEARCH_INDEX,
  QUEUE_SEARCH,
  type SearchJob,
} from '../../queue/queue.types';

// settings-exempt: polling cadence of the outbox relay (how fresh search is, ops tuning); a change waits at most this long plus one batch
const RELAY_EVERY_MS = 2_000;
// settings-exempt: cron schedules for background upkeep (ops tuning)
const SWEEP_SCHEDULE = '*/15 * * * *';
// settings-exempt: see above; retention itself is the outbox_processed_retention_days setting
const PURGE_SCHEDULE = '45 3 * * *';
const SCHEDULE_TIMEZONE = 'Asia/Dhaka';

/**
 * Registers the search upkeep jobs (worker only; idempotent across restarts)
 * and applies index settings once on start, so a deploy that changes the
 * synonym dictionary or ranking takes effect without a manual step.
 */
@Injectable()
export class SearchSchedule implements OnModuleInit {
  constructor(@InjectQueue(QUEUE_SEARCH) private readonly queue: Queue<SearchJob>) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_RELAY_SEARCH_OUTBOX,
      { every: RELAY_EVERY_MS },
      { name: JOB_RELAY_SEARCH_OUTBOX, data: {} },
    );
    await this.queue.upsertJobScheduler(
      JOB_SWEEP_SEARCH_INDEX,
      { pattern: SWEEP_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_SWEEP_SEARCH_INDEX, data: {} },
    );
    await this.queue.upsertJobScheduler(
      JOB_PURGE_SEARCH_OUTBOX,
      { pattern: PURGE_SCHEDULE, tz: SCHEDULE_TIMEZONE },
      { name: JOB_PURGE_SEARCH_OUTBOX, data: {} },
    );
    await this.queue.add(JOB_APPLY_SEARCH_SETTINGS, {});
  }
}

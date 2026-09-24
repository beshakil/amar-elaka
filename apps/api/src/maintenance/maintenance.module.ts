import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  JOB_ENSURE_AUDIT_LOG_PARTITIONS,
  QUEUE_MAINTENANCE,
  type EnsureAuditLogPartitionsJob,
} from '../queue/queue.types';
import { EnsureAuditLogPartitionsProcessor } from './ensure-audit-log-partitions.processor';

// settings-exempt: how many months of partitions to keep pre-created — ops/scheduling tuning, not a business rule
const PARTITION_MONTHS_AHEAD = 3;
// settings-exempt: cron schedule (03:00 on the 1st of each month) for the partition-maintenance job — ops tuning, not a business rule
const MONTHLY_PARTITION_SCHEDULE = '0 3 1 * *';
const MONTHLY_JOB_SCHEDULER_ID = 'ensure-audit-log-partitions-monthly';

/**
 * Registers the repeatable schedule and fires one immediate run on boot so
 * the fix is directly observable without waiting a month — worker-only
 * (registered in WorkerModule, not AppModule): this is background
 * maintenance on a global table, not something an HTTP request should ever
 * trigger.
 */
@Injectable()
class AuditLogPartitionSchedule implements OnModuleInit {
  constructor(
    @InjectQueue(QUEUE_MAINTENANCE) private readonly queue: Queue<EnsureAuditLogPartitionsJob>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      MONTHLY_JOB_SCHEDULER_ID,
      { pattern: MONTHLY_PARTITION_SCHEDULE },
      { name: JOB_ENSURE_AUDIT_LOG_PARTITIONS, data: { months: PARTITION_MONTHS_AHEAD } },
    );
    await this.queue.add(JOB_ENSURE_AUDIT_LOG_PARTITIONS, { months: PARTITION_MONTHS_AHEAD });
  }
}

@Module({
  providers: [EnsureAuditLogPartitionsProcessor, AuditLogPartitionSchedule],
})
export class MaintenanceModule {}

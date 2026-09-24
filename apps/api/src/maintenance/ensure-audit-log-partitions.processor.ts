import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { relayToDeadLetterQueueOnFinalFailure } from '../queue/dlq.util';
import {
  deadLetterQueueName,
  JOB_ENSURE_AUDIT_LOG_PARTITIONS,
  QUEUE_MAINTENANCE,
  type EnsureAuditLogPartitionsJob,
} from '../queue/queue.types';

const RESULT_ROW = z.object({ ensure_audit_log_partitions: z.number().int().nonnegative() });

/**
 * `ensure_audit_log_partitions()` (infra/migrations/0001, hardened in 0002)
 * was called exactly once at migration time — nothing has kept creating
 * future months' partitions since. This processor is that missing scheduler:
 * MaintenanceModule enqueues it on a monthly repeat plus once immediately on
 * boot (see maintenance.module.ts).
 */
@Processor(QUEUE_MAINTENANCE)
export class EnsureAuditLogPartitionsProcessor extends WorkerHost {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    @InjectQueue(deadLetterQueueName(QUEUE_MAINTENANCE)) private readonly dlq: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(EnsureAuditLogPartitionsProcessor.name);
  }

  async process(job: Job<EnsureAuditLogPartitionsJob>): Promise<void> {
    if (job.name !== JOB_ENSURE_AUDIT_LOG_PARTITIONS) return;
    const { months } = job.data;

    // Platform-wide maintenance on a global table, not tenant data — runs as
    // `system`, same idiom as PermissionsService/TenantLookupService/PgSettingsSource.
    const created = await this.tenantContext.run({ role: 'system' }, () =>
      this.tenantDb.transaction(async (tx) => {
        const rows = await tx.execute(
          sql`select public.ensure_audit_log_partitions(current_date, ${months}) as ensure_audit_log_partitions`,
        );
        const [row] = z
          .array(RESULT_ROW)
          .nonempty()
          .parse([...rows]);
        return row.ensure_audit_log_partitions;
      }),
    );

    this.logger.info({ created, months }, 'ensured audit log partitions');
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<EnsureAuditLogPartitionsJob> | undefined, error: Error): Promise<void> {
    this.logger.warn({ jobId: job?.id, err: error }, 'ensure-audit-log-partitions job failed');
    if (job) await relayToDeadLetterQueueOnFinalFailure(this.dlq, job, error);
  }
}

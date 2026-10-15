import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { NotificationService } from '../notifications/notification.service';
import { SettingsService } from '../settings/settings.service';
import { deepLinkFor } from './verification-moderation.service';
import { VerificationRepository } from './verification.repository';

/**
 * Verification's background work (ADR 062), run by the notifications worker:
 *  - expire: approvals past their date become expired — the badge goes at
 *    once (the caches follow in the same transaction) — and their holders
 *    are told; holders inside the renewal window are reminded, once;
 *  - purge: evidence files go verification_doc_retention_days after the
 *    decision (never under a legal hold), via the media purge.
 */
@Injectable()
export class VerificationJobsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: VerificationRepository,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VerificationJobsService.name);
  }

  async expireAndRemind(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const expired = await this.asSystem((tx) => this.repo.expire(tx, limit));
    const reminders = await this.asSystem((tx) => this.repo.dueReminders(tx, limit));
    for (const e of expired) {
      await this.tell(() =>
        this.notifications.send({
          userId: e.user_id,
          type: 'verification_expired',
          tenantId: e.tenant_id,
          params: { storeName: e.store_name },
          deepLink: deepLinkFor(e.subject_type, e.subject_id),
          entityId: e.verification_id,
          dedupeKey: `verification_expired:${e.verification_id}`,
        }),
      );
    }
    for (const r of reminders) {
      await this.tell(() =>
        this.notifications.send({
          userId: r.user_id,
          type: 'verification_expiring',
          tenantId: r.tenant_id,
          params: { storeName: r.store_name, expiresAt: r.expires_at },
          deepLink: r.subject_type === 'store' ? null : '/verification',
          entityId: r.verification_id,
          dedupeKey: `verification_expiring:${r.verification_id}`,
        }),
      );
    }
    return {
      rows: expired.length + reminders.length,
      capped: expired.length === limit || reminders.length === limit,
      details: { expired: expired.length, reminded: reminders.length },
    };
  }

  async purgeDocuments(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const purged = await this.asSystem((tx) => this.repo.purgeDocuments(tx, limit));
    return { rows: purged, capped: purged === limit };
  }

  private async limit(budget: JobBudget): Promise<number> {
    return Math.min(
      budget.batchSize * budget.maxBatches,
      await this.settings.get('verification_job_batch_size'),
    );
  }

  private async tell(send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.warn({ err: error }, 'verification notice not queued');
    }
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

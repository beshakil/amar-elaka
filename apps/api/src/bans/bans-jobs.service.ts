import { Injectable } from '@nestjs/common';
import { BanStateService } from '../auth/ban-state.service';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { SettingsService } from '../settings/settings.service';
import { BAN_DEEP_LINKS, BanNotifier } from './ban-notifier';
import { BanEffects } from './ban-effects';
import { BansRepository } from './bans.repository';

/**
 * The scheduled side of ADR 063, run by the notifications worker:
 *  - expire-bans: bans and blacklist entries past their end (the badge of a
 *    ban drops at once regardless; this tidies the rows and tells the person);
 *  - escalate-appeals: an area that hasn't decided by escalate_at loses the
 *    appeal to the platform;
 *  - complaint-sla: open complaints past their due time, flagged once.
 */
@Injectable()
export class BansJobsService {
  constructor(
    private readonly effects: BanEffects,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: BansRepository,
    private readonly state: BanStateService,
    private readonly notifier: BanNotifier,
    private readonly settings: SettingsService,
  ) {}

  async expire(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const rows = await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.expire(tx, limit)),
    );
    for (const r of rows) {
      if (!r.user_id) continue;
      await this.effects.changed(r.user_id, r.tenant_id);
      await this.notifier.toUser(
        r.user_id,
        'ban_lifted',
        r.tenant_id,
        { reference: r.reference_code },
        BAN_DEEP_LINKS.account,
        r.id,
        `ban_lifted:${r.id}`,
      );
    }
    return { rows: rows.length, capped: rows.length >= limit };
  }

  async escalate(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const rows = await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.escalateDue(tx, limit)),
    );
    for (const r of rows) {
      await this.notifier.toStaff(
        'platform_admins',
        null,
        'appeal_received',
        { reference: r.public_reference, escalated: 'true' },
        BAN_DEEP_LINKS.appealsPlatform,
        r.id,
        `appeal_escalated:${r.id}`,
      );
    }
    return { rows: rows.length, capped: rows.length >= limit };
  }

  async complaintSla(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const rows = await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.slaBreaches(tx, limit)),
    );
    for (const r of rows) {
      const params = { reference: r.reference_code };
      const dedupe = `complaint_sla_breached:${r.id}`;
      if (r.assigned_to_user_id) {
        await this.notifier.toUser(
          r.assigned_to_user_id,
          'complaint_sla_breached',
          r.tenant_id,
          params,
          BAN_DEEP_LINKS.complaints,
          r.id,
          dedupe,
        );
      } else {
        await this.notifier.toStaff(
          'area_admins',
          r.tenant_id,
          'complaint_sla_breached',
          params,
          BAN_DEEP_LINKS.complaints,
          r.id,
          dedupe,
        );
      }
    }
    return { rows: rows.length, capped: rows.length >= limit };
  }

  private async limit(budget: JobBudget): Promise<number> {
    return Math.min(
      budget.batchSize * budget.maxBatches,
      await this.settings.get('ban_job_batch_size'),
    );
  }

  private asSystem<T>(work: () => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, work);
  }
}

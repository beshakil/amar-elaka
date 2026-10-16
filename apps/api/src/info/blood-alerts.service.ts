import { Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { SettingsService } from '../settings/settings.service';
import { BloodNotifier } from './blood-notifier';
import { InfoRepository } from './info.repository';

/**
 * Urgent requests reaching donors (ADR 064), and their end:
 *  - alert(): THE matcher run — blood_request_alert_donors() picks the donors
 *    (compatible, listable, alerts on, nearby, in their contact window, under
 *    their daily cap) and records one alert each; then the pushes. The API
 *    runs it right after a request is created; the alert-blood-donors job
 *    catches any request a crash left unmatched.
 *  - expire(): the expire-blood-requests job closes requests
 *    blood_request_grace_hours past their needed-by time.
 * Both run as the system (cross-area by nature).
 */
@Injectable()
export class BloodAlertsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: InfoRepository,
    private readonly notifier: BloodNotifier,
    private readonly settings: SettingsService,
  ) {}

  /** Returns how many donors were alerted (0 when already matched). */
  async alert(requestId: string): Promise<number> {
    const { alerts, request } = await this.asSystem(() =>
      this.tenantDb.transaction(async (tx) => ({
        alerts: await this.repo.alertDonors(tx, requestId),
        request: await this.repo.request(tx, requestId),
      })),
    );
    if (request && alerts.length > 0) {
      await this.notifier.alerts(
        {
          id: request.id,
          bloodGroup: request.blood_group_code,
          units: request.units_needed,
          hospitalName: request.hospital_name,
        },
        alerts,
      );
    }
    return alerts.length;
  }

  async alertPending(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const ids = await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.requestsToAlert(tx, limit), {
        accessMode: 'read only',
      }),
    );
    for (const id of ids) await this.alert(id);
    return { rows: ids.length, capped: ids.length >= limit };
  }

  async expire(budget: JobBudget): Promise<JobOutcome> {
    const limit = await this.limit(budget);
    const n = await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.expireRequests(tx, limit)),
    );
    return { rows: n, capped: n >= limit };
  }

  private async limit(budget: JobBudget): Promise<number> {
    return Math.min(
      budget.batchSize * budget.maxBatches,
      await this.settings.get('blood_job_batch_size'),
    );
  }

  private asSystem<T>(work: () => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, work);
  }
}

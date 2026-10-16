import { Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget, JobOutcome } from '../jobs/job-batches';
import { SettingsService } from '../settings/settings.service';
import { InfoEngineRepository } from './info-engine.repository';

/**
 * The engine's one expiry job, expire-info-items (ADR 065): notices past
 * their end, lost & found past theirs (archived), scheduled outages past
 * their end. Outage reports need nothing: they count only until expires_at.
 */
@Injectable()
export class InfoJobsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: InfoEngineRepository,
    private readonly settings: SettingsService,
  ) {}

  async expire(budget: JobBudget): Promise<JobOutcome> {
    const limit = Math.min(
      budget.batchSize * budget.maxBatches,
      await this.settings.get('info_job_batch_size'),
    );
    const done = await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx) => this.repo.expire(tx, limit)),
    );
    const rows = done.notices + done.lost_found + done.outages;
    return { rows, capped: [done.notices, done.lost_found, done.outages].some((n) => n >= limit) };
  }
}

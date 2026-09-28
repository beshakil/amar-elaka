import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobOutcome } from '../jobs/job-batches';
import { PermissionDeniedException } from '../rbac/rbac.exceptions';
import { SettingsService } from '../settings/settings.service';
import type { UnmetDemand } from './dto/analytics.dto';

/** Who may read it: the tenant's admins and platform staff (unmet_demand_for_tenant checks too). */
const READERS: ReadonlySet<string> = new Set([
  'tenant_admin',
  'partner_owner',
  'platform_admin',
  'platform_support',
  'platform_finance',
]);

const nullableText = z.string().nullable();
const ROW = z.object({
  category_id: nullableText,
  category_slug: nullableText,
  category_name_bn: nullableText,
  category_name_en: nullableText,
  geo_area_id: nullableText,
  geo_area_name_bn: nullableText,
  geo_area_name_en: nullableText,
  active_saved_searches: z.number(),
  weak_searches: z.number(),
  refreshed_at: z.coerce.date(),
});

/**
 * Unmet demand (ADR 041): per category and area of this tenant, how many
 * people keep an alert running and how many searches found (almost) nothing.
 * From the unmet_demand materialized view (0035), refreshed on a schedule;
 * the view has no RLS, so it is read only through unmet_demand_for_tenant(),
 * which serves the current tenant's rows to its admins and platform staff.
 */
@Injectable()
export class UnmetDemandService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly settings: SettingsService,
  ) {}

  async forTenant(): Promise<UnmetDemand> {
    // A marketer holds analytics:read too; this report is the admins' alone.
    if (!READERS.has(this.context.require().role ?? 'anon')) {
      throw new PermissionDeniedException('analytics', 'read');
    }
    const [resultThreshold, windowDays] = await Promise.all([
      this.settings.get('unmet_demand_result_threshold'),
      this.settings.get('unmet_demand_window_days'),
    ]);
    const rows = await this.tenantDb.transaction(
      async (tx) =>
        z.array(ROW).parse([
          ...(await tx.execute(sql`
            select category_id, category_slug, category_name_bn, category_name_en,
                   geo_area_id, geo_area_name_bn, geo_area_name_en,
                   active_saved_searches, weak_searches, refreshed_at
            from public.unmet_demand_for_tenant()`)),
        ]),
      { accessMode: 'read only' },
    );
    return {
      refreshedAt: rows[0]?.refreshed_at.toISOString() ?? null,
      resultThreshold,
      windowDays,
      rows: rows.map((r) => ({
        category:
          r.category_id === null
            ? null
            : {
                id: r.category_id,
                slug: r.category_slug,
                name: { bn: r.category_name_bn, en: r.category_name_en },
              },
        geoArea:
          r.geo_area_id === null
            ? null
            : { id: r.geo_area_id, name: { bn: r.geo_area_name_bn, en: r.geo_area_name_en } },
        activeSavedSearches: r.active_saved_searches,
        weakSearches: r.weak_searches,
      })),
    };
  }

  /** The scheduled refresh (worker). */
  async refresh(): Promise<JobOutcome> {
    await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx: DatabaseTransaction) =>
        tx.execute(sql`select public.refresh_unmet_demand()`),
      ),
    );
    return { rows: 1, capped: false };
  }
}

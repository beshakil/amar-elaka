import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import type { StoreActivity, StoreActivityQuery } from './dto/analytics.dto';

const ROW = z.object({
  month: z.coerce.string(),
  active_stores: z.number(),
  posting_stores: z.number(),
  store_posts: z.number(),
  avg_posts_per_active_store: z.string().nullable(),
  avg_posts_per_posting_store: z.string().nullable(),
});

/**
 * Tenant analytics (ADR 037). Only what a product decision needs today: how
 * often stores post, month by month, to decide whether a following feed is
 * worth building. No dashboard; the numbers come from tenant_store_activity
 * (0032), which also checks the caller's role.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
  ) {}

  async storeActivity(query: StoreActivityQuery): Promise<StoreActivity> {
    const [monthsDefault, monthsMax] = await Promise.all([
      this.settings.get('store_activity_months_default'),
      this.settings.get('store_activity_months_max'),
    ]);
    const months = Math.min(query.months ?? monthsDefault, monthsMax);
    const rows = await this.tenantDb.transaction(
      async (tx) =>
        z.array(ROW).parse([
          ...(await tx.execute(sql`
            select month::text as month, active_stores, posting_stores, store_posts,
                   avg_posts_per_active_store::text as avg_posts_per_active_store,
                   avg_posts_per_posting_store::text as avg_posts_per_posting_store
            from public.tenant_store_activity(${months}::integer)`)),
        ]),
      { accessMode: 'read only' },
    );
    return {
      months: rows.map((row) => ({
        month: row.month,
        activeStores: row.active_stores,
        postingStores: row.posting_stores,
        storePosts: row.store_posts,
        avgPostsPerActiveStore: row.avg_posts_per_active_store,
        avgPostsPerPostingStore: row.avg_posts_per_posting_store,
      })),
    };
  }
}

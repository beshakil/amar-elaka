import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { NotificationService } from '../../notifications/notification.service';
import { GEO_BUDGET_STORE, type GeoBudgetStore } from './geo-budget.store';

const SECONDS_PER_DAY = 86_400; // settings-exempt: unit conversion
// settings-exempt: an alert flag outlives its Dhaka day in any timezone
const ALERT_FLAG_TTL_SECONDS = 2 * SECONDS_PER_DAY;
const PERCENT = 100; // settings-exempt: unit conversion
const AdminRow = z.object({ id: z.string() });

/**
 * Tells the platform admins (in-app; push joins in week 11) when the day's
 * Barikoi budget reaches `barikoi_budget_warn_pct`, and when it is spent —
 * once per Asia/Dhaka day each, however many requests cross the line
 * (Redis flag, plus the notification's own dedupe key). Never throws.
 */
@Injectable()
export class GeoBudgetAlerts {
  constructor(
    @Inject(GEO_BUDGET_STORE) private readonly store: GeoBudgetStore,
    private readonly notifications: NotificationService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GeoBudgetAlerts.name);
  }

  /** After a reservation: warn once when the day's total reaches the threshold. */
  async afterReserve(
    provider: string,
    day: string,
    total: number,
    budget: number,
    warnPct: number,
  ): Promise<void> {
    if (total * PERCENT < budget * warnPct) return;
    await this.alert('geo_budget_warning', provider, day, { used: total, budget, warnPct });
  }

  /** The budget refused a call: the day's budget is spent. */
  async exhausted(provider: string, day: string, budget: number): Promise<void> {
    await this.alert('geo_budget_exhausted', provider, day, { used: budget, budget });
  }

  private async alert(
    type: 'geo_budget_warning' | 'geo_budget_exhausted',
    provider: string,
    day: string,
    numbers: Record<string, number>,
  ): Promise<void> {
    try {
      const first = await this.store.once(
        `geo:alert:${type}:${provider}:${day}`,
        ALERT_FLAG_TTL_SECONDS,
      );
      if (first === false) return; // already sent today (null: Redis down — the dedupe key still holds)
      const admins = await this.context.run({ role: 'system' }, () =>
        this.tenantDb.transaction(async (tx) =>
          z.array(AdminRow).parse([
            ...(await tx.execute(sql`
              select id from users
              where platform_role_code = 'platform_admin'
                and status_code = 'active' and deleted_at is null`)),
          ]),
        ),
      );
      const params = {
        provider,
        day,
        ...Object.fromEntries(Object.entries(numbers).map(([k, v]) => [k, String(v)])),
      };
      for (const admin of admins) {
        await this.notifications.send({
          userId: admin.id,
          type,
          params,
          deepLink: null,
          entityId: null,
          dedupeKey: `${type}:${provider}:${day}`,
        });
      }
      this.logger.warn(
        { type, provider, day, ...numbers, admins: admins.length },
        'geo budget alert',
      );
    } catch (error) {
      this.logger.error({ err: error, type }, 'could not send a geo budget alert');
    }
  }
}

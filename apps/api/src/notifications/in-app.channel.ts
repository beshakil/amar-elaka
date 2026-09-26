import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { NotificationChannel, OutgoingNotification } from './notification-channel';

/**
 * The in-app inbox: a row in `notifications` (user-level, read by the user in
 * any tenant). Only `system` may insert (RLS, 0009), so it writes in a system
 * context of its own.
 */
@Injectable()
export class InAppNotificationChannel implements NotificationChannel {
  readonly name = 'in_app';

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
  ) {}

  async deliver(n: OutgoingNotification): Promise<void> {
    await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx) =>
        tx.execute(sql`
          insert into public.notifications (user_id, type_code, params, deep_link, entity_id, dedupe_key)
          select ${n.userId}::uuid, ${n.type}, ${JSON.stringify(n.params)}::jsonb, ${n.deepLink},
                 ${n.entityId}::uuid, ${n.dedupeKey}
          where ${n.dedupeKey}::text is null or not exists (
            select 1 from public.notifications x
            where x.user_id = ${n.userId}::uuid and x.dedupe_key = ${n.dedupeKey}
          )`),
      ),
    );
  }
}

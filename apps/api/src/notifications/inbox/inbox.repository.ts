import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../database/database.client';

const ROW = z.object({
  id: z.string(),
  type_code: z.string(),
  params: z.record(z.unknown()),
  deep_link: z.string().nullable(),
  entity_id: z.string().nullable(),
  read_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});
export type InboxRow = z.infer<typeof ROW>;

/** What the inbox shows: the caller's own (RLS), not archived, not expired. */
const VISIBLE = sql`archived_at is null and (expires_at is null or expires_at > now())`;

/** The caller's notifications (RLS notifications_owner_read / _update, 0009). */
@Injectable()
export class InboxRepository {
  async page(tx: DatabaseTransaction, before: string | null, limit: number): Promise<InboxRow[]> {
    const rows = await tx.execute(sql`
      select id, type_code, params, deep_link, entity_id, read_at, created_at
      from public.notifications
      where user_id = public.current_user_id() and ${VISIBLE}
        ${before ? sql`and id < ${before}::uuid` : sql``}
      order by id desc
      limit ${limit}`);
    return z.array(ROW).parse([...rows]);
  }

  async unreadCount(tx: DatabaseTransaction): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::int as n from public.notifications
      where user_id = public.current_user_id() and read_at is null and ${VISIBLE}`);
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  /** False when it isn't the caller's (or doesn't exist). */
  async markRead(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.notifications set read_at = coalesce(read_at, now())
      where id = ${id}::uuid and user_id = public.current_user_id()
      returning id`);
    return rows.length > 0;
  }

  async markAllRead(tx: DatabaseTransaction): Promise<number> {
    const rows = await tx.execute(sql`
      update public.notifications set read_at = now()
      where user_id = public.current_user_id() and read_at is null and ${VISIBLE}
      returning id`);
    return rows.length;
  }
}

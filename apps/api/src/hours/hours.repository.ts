import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { toOpenState, type OpenState } from './open-state';

export type HoursEntity = 'place' | 'store';
export type HoursOwner = { placeId: string } | { storeId: string };

const RANGE_ROW = z.object({
  day: z.number(),
  opens: z.string(),
  closes: z.string(),
  next_day: z.boolean(),
});
export type RangeRow = z.infer<typeof RANGE_ROW>;

const SPECIAL_ROW = z.object({
  on_date: z.string(),
  is_closed: z.boolean(),
  opens: z.string().nullable(),
  closes: z.string().nullable(),
  next_day: z.boolean(),
  note: z.string().nullable(),
});
export type SpecialRow = z.infer<typeof SPECIAL_ROW>;

const STORE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  place_id: z.string().nullable(),
  closed_until: z.coerce.date().nullable(),
});
export type StoreRow = z.infer<typeof STORE_ROW>;

const PLACE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  claimed_by_member_id: z.string().nullable(),
  closed_until: z.coerce.date().nullable(),
});
export type HoursPlaceRow = z.infer<typeof PLACE_ROW>;

export interface NewRange {
  day: number;
  opens: string;
  closes: string;
  nextDay: boolean;
}

export interface NewSpecialRow {
  date: string;
  closed: boolean;
  opens: string | null;
  closes: string | null;
  nextDay: boolean;
  note: string | null;
}

const ownerColumn = (owner: HoursOwner): SQL =>
  'placeId' in owner
    ? sql`place_id = ${owner.placeId}::uuid`
    : sql`store_id = ${owner.storeId}::uuid`;
const ownerId = (owner: HoursOwner): string => ('placeId' in owner ? owner.placeId : owner.storeId);

/**
 * Hours reads and writes (0044). Open states always come from the database's
 * is_open_at() (via open_states) — there is no second implementation here.
 */
@Injectable()
export class HoursRepository {
  /** is_open_at for each id, now. */
  async openStates(
    tx: DatabaseTransaction,
    entity: HoursEntity,
    ids: readonly string[],
  ): Promise<Map<string, OpenState | null>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.execute(sql`
      select id, state, changes_at
      from public.open_states(${entity}, array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[], now())`);
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          state: z.string().nullable(),
          changes_at: z.coerce.date().nullable(),
        }),
      )
      .parse([...rows]);
    return new Map(parsed.map((r) => [r.id, toOpenState(r.state, r.changes_at)]));
  }

  /** The owning tenant of a place or store (item_tenant_of, 0032). */
  async tenantOf(
    tx: DatabaseTransaction,
    entity: HoursEntity,
    id: string,
  ): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of(${entity}, ${id}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  /** `forUpdate` applies the UPDATE policy (store managers, staff). */
  async findStore(
    tx: DatabaseTransaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<StoreRow | undefined> {
    const rows = await tx.execute(sql`
      select id, tenant_id, place_id, closed_until from public.stores
      where id = ${id}::uuid and deleted_at is null ${options.forUpdate ? sql`for update` : sql``}`);
    return z
      .array(STORE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** `forUpdate` applies the UPDATE policy (staff, agents, the claimed owner). */
  async findPlace(
    tx: DatabaseTransaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<HoursPlaceRow | undefined> {
    const rows = await tx.execute(sql`
      select id, tenant_id, claimed_by_member_id, closed_until from public.places
      where id = ${id}::uuid and deleted_at is null ${options.forUpdate ? sql`for update` : sql``}`);
    return z
      .array(PLACE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async storeWeekly(tx: DatabaseTransaction, storeId: string): Promise<RangeRow[]> {
    const rows = await tx.execute(sql`
      select iso_day_of_week as day, to_char(opens_at, 'HH24:MI') as opens,
             to_char(closes_at, 'HH24:MI') as closes, closes_next_day as next_day
      from public.store_hours where store_id = ${storeId}::uuid
      order by iso_day_of_week, opens_at`);
    return z.array(RANGE_ROW).parse([...rows]);
  }

  async placeWeekly(tx: DatabaseTransaction, placeId: string): Promise<RangeRow[]> {
    const rows = await tx.execute(sql`
      select iso_day_of_week as day, to_char(opens_at, 'HH24:MI') as opens,
             to_char(closes_at, 'HH24:MI') as closes, closes_next_day as next_day
      from public.place_hours where place_id = ${placeId}::uuid
      order by iso_day_of_week, opens_at`);
    return z.array(RANGE_ROW).parse([...rows]);
  }

  async replaceStoreWeekly(
    tx: DatabaseTransaction,
    storeId: string,
    ranges: readonly NewRange[],
  ): Promise<void> {
    await tx.execute(sql`delete from public.store_hours where store_id = ${storeId}::uuid`);
    if (ranges.length === 0) return;
    const values = ranges.map(
      (r) => sql`(${storeId}::uuid, ${r.day}, ${r.opens}::time, ${r.closes}::time, ${r.nextDay})`,
    );
    await tx.execute(sql`
      insert into public.store_hours (store_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
      values ${sql.join(values, sql`, `)}`);
  }

  /** Today in the owning tenant's own zone (tenants.timezone), as YYYY-MM-DD. */
  async localToday(tx: DatabaseTransaction, tenantId: string): Promise<string> {
    const rows = await tx.execute(sql`
      select to_char((now() at time zone t.timezone)::date, 'YYYY-MM-DD') as today
      from public.tenants t where t.id = ${tenantId}::uuid`);
    return z
      .array(z.object({ today: z.string() }))
      .length(1)
      .parse([...rows])[0]!.today;
  }

  /** Special days from today (local) on. */
  async upcomingSpecialDays(
    tx: DatabaseTransaction,
    owner: HoursOwner,
    today: string,
  ): Promise<SpecialRow[]> {
    const rows = await tx.execute(sql`
      select to_char(on_date, 'YYYY-MM-DD') as on_date, is_closed,
             to_char(opens_at, 'HH24:MI') as opens, to_char(closes_at, 'HH24:MI') as closes,
             closes_next_day as next_day, note
      from public.hours_exceptions
      where ${ownerColumn(owner)} and on_date >= ${today}::date
      order by on_date, opens_at nulls first`);
    return z.array(SPECIAL_ROW).parse([...rows]);
  }

  /** Replaces the special days from `today` on; earlier ones stay as history. */
  async replaceSpecialDays(
    tx: DatabaseTransaction,
    owner: HoursOwner,
    today: string,
    rows: readonly NewSpecialRow[],
    userId: string,
  ): Promise<void> {
    await tx.execute(sql`
      delete from public.hours_exceptions where ${ownerColumn(owner)} and on_date >= ${today}::date`);
    if (rows.length === 0) return;
    const [placeId, storeId] = 'placeId' in owner ? [ownerId(owner), null] : [null, ownerId(owner)];
    const values = rows.map(
      (r) => sql`(${placeId}::uuid, ${storeId}::uuid, ${r.date}::date, ${r.closed},
                  ${r.opens}::time, ${r.closes}::time, ${r.nextDay}, ${r.note}, ${userId}::uuid)`,
    );
    await tx.execute(sql`
      insert into public.hours_exceptions
        (place_id, store_id, on_date, is_closed, opens_at, closes_at, closes_next_day, note, created_by_user_id)
      values ${sql.join(values, sql`, `)}`);
  }

  /**
   * "Closed today": closed_until = the next midnight in the owning tenant's
   * zone, or cleared. Runs under the table's UPDATE policy; undefined when
   * the caller may not update the row.
   */
  async setClosedToday(
    tx: DatabaseTransaction,
    entity: HoursEntity,
    id: string,
    closed: boolean,
  ): Promise<{ closedUntil: Date | null } | undefined> {
    const table = entity === 'place' ? sql`public.places` : sql`public.stores`;
    const rows = await tx.execute(sql`
      update ${table} e
      set closed_until = ${
        closed
          ? sql`(((now() at time zone t.timezone)::date + 1)::timestamp at time zone t.timezone)`
          : sql`null`
      }
      from public.tenants t
      where e.id = ${id}::uuid and t.id = e.tenant_id
      returning e.closed_until`);
    const [row] = z
      .array(z.object({ closed_until: z.coerce.date().nullable() }))
      .max(1)
      .parse([...rows]);
    return row && { closedUntil: row.closed_until };
  }
}

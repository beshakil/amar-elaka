import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { isStaffRole } from '../posts/post-visibility';
import { SettingsService } from '../settings/settings.service';
import type {
  ClosedTodayResult,
  HoursView,
  SpecialDaysInput,
  SpecialDayView,
  StoreWeeklyInput,
} from './dto/hours.dto';
import {
  HoursEntityNotFoundException,
  InvalidSpecialDaysException,
  NotHoursEditorException,
  TooManyRangesPerDayException,
} from './hours.exceptions';
import {
  HoursRepository,
  type HoursEntity,
  type HoursOwner,
  type NewSpecialRow,
  type RangeRow,
  type SpecialRow,
} from './hours.repository';

/** "HH:MM" ranges → rows; closing at or before opening runs past midnight. */
export function toRanges<T extends { opens: string; closes: string }>(
  ranges: readonly T[],
): (T & { nextDay: boolean })[] {
  return ranges.map((r) => ({ ...r, nextDay: r.closes <= r.opens }));
}

/** At most hours_ranges_per_day_max ranges on any one day (the key: weekday or date). */
export function assertRangesPerDay(keys: readonly (number | string)[], max: number): void {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(String(key), (counts.get(String(key)) ?? 0) + 1);
  const over = [...counts].filter(([, n]) => n > max).map(([key]) => key);
  if (over.length > 0) throw new TooManyRangesPerDayException(max, over);
}

export function toWeeklyView(rows: readonly RangeRow[]): HoursView['weekly'] {
  return rows.map((r) => ({
    day: r.day,
    opens: r.opens,
    closes: r.closes,
    closesNextDay: r.next_day,
  }));
}

export function toSpecialDayViews(rows: readonly SpecialRow[]): SpecialDayView[] {
  const byDate = new Map<string, SpecialDayView>();
  for (const row of rows) {
    const day = byDate.get(row.on_date) ?? {
      date: row.on_date,
      closed: false,
      ranges: [],
      note: row.note,
    };
    if (row.is_closed) day.closed = true;
    else if (row.opens && row.closes) {
      day.ranges.push({ opens: row.opens, closes: row.closes, closesNextDay: row.next_day });
    }
    day.note ??= row.note;
    byDate.set(row.on_date, day);
  }
  return [...byDate.values()].map((d) => (d.closed ? { ...d, ranges: [] } : d));
}

const isRealDate = (date: string): boolean => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
};

/**
 * Hours that aren't a place's weekly schedule (which PATCH /places/:id sets,
 * versioned): a store's weekly schedule, special days of a place or store,
 * and the owner's "closed today" (ADR 049). Every write runs in the entity's
 * owning tenant, under its RLS; every open state is the database's
 * is_open_at().
 */
@Injectable()
export class HoursService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: HoursRepository,
    private readonly ownership: PostOwnershipService,
    private readonly settings: SettingsService,
  ) {}

  /** A store's schedule, special days, toggle and open state (public for an active store). */
  async storeHours(storeId: string): Promise<HoursView> {
    const tenantId = await this.tenantOf('store', storeId);
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(
        async (tx) => {
          const store = await this.repo.findStore(tx, storeId);
          if (!store) throw new HoursEntityNotFoundException();
          const own = await this.repo.storeWeekly(tx, storeId);
          const usesPlaceHours = own.length === 0 && store.place_id !== null;
          const weekly = usesPlaceHours ? await this.repo.placeWeekly(tx, store.place_id!) : own;
          const today = await this.repo.localToday(tx, tenantId);
          const [special, states] = await Promise.all([
            this.repo.upcomingSpecialDays(tx, { storeId }, today),
            this.repo.openStates(tx, 'store', [storeId]),
          ]);
          return {
            weekly: toWeeklyView(weekly),
            usesPlaceHours,
            specialDays: toSpecialDayViews(special),
            closedUntil: store.closed_until?.toISOString() ?? null,
            openState: states.get(storeId) ?? null,
          };
        },
        { accessMode: 'read only' },
      ),
    );
  }

  async setStoreWeekly(storeId: string, input: StoreWeeklyInput): Promise<HoursView> {
    this.requireUserId();
    const max = await this.settings.get('hours_ranges_per_day_max');
    assertRangesPerDay(
      input.weekly.map((r) => r.day),
      max,
    );
    const tenantId = await this.tenantOf('store', storeId);
    await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(async (tx) => {
        await this.lockEditable(tx, 'store', storeId);
        await this.repo.replaceStoreWeekly(tx, storeId, toRanges(input.weekly));
      }),
    );
    return this.storeHours(storeId);
  }

  /** Replaces the upcoming special days of a place or store. */
  async setSpecialDays(
    entity: HoursEntity,
    id: string,
    input: SpecialDaysInput,
  ): Promise<SpecialDayView[]> {
    const userId = this.requireUserId();
    const [maxDays, maxRanges] = await Promise.all([
      this.settings.get('hours_special_days_max'),
      this.settings.get('hours_ranges_per_day_max'),
    ]);
    const dates = input.days.map((d) => d.date);
    const invalid = dates.filter((d) => !isRealDate(d));
    if (invalid.length > 0) throw new InvalidSpecialDaysException('invalid_date', invalid);
    const duplicates = dates.filter((d, i) => dates.indexOf(d) !== i);
    if (duplicates.length > 0)
      throw new InvalidSpecialDaysException('duplicate', [...new Set(duplicates)]);
    if (dates.length > maxDays) throw new InvalidSpecialDaysException('too_many', [], maxDays);
    assertRangesPerDay(
      input.days.flatMap((d) => d.ranges.map(() => d.date)),
      maxRanges,
    );
    const rows: NewSpecialRow[] = input.days.flatMap((d): NewSpecialRow[] =>
      d.closed
        ? [
            {
              date: d.date,
              closed: true,
              opens: null,
              closes: null,
              nextDay: false,
              note: d.note ?? null,
            },
          ]
        : toRanges(d.ranges).map((r) => ({
            date: d.date,
            closed: false,
            opens: r.opens,
            closes: r.closes,
            nextDay: r.nextDay,
            note: d.note ?? null,
          })),
    );

    const tenantId = await this.tenantOf(entity, id);
    const owner: HoursOwner = entity === 'place' ? { placeId: id } : { storeId: id };
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(async (tx) => {
        await this.lockEditable(tx, entity, id);
        const today = await this.repo.localToday(tx, tenantId);
        const past = dates.filter((d) => d < today);
        if (past.length > 0) throw new InvalidSpecialDaysException('past', past);
        await this.repo.replaceSpecialDays(tx, owner, today, rows, userId);
        return toSpecialDayViews(await this.repo.upcomingSpecialDays(tx, owner, today));
      }),
    );
  }

  /** The owner's toggle: closed until the next local midnight, or open again. */
  async setClosedToday(
    entity: HoursEntity,
    id: string,
    closed: boolean,
  ): Promise<ClosedTodayResult> {
    this.requireUserId();
    const tenantId = await this.tenantOf(entity, id);
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId, role }) =>
      this.tenantDb.transaction(async (tx) => {
        const place = await this.lockEditable(tx, entity, id);
        // A place's "closed today" is its owner's (or staff's) word, not a field agent's.
        if (place && !isStaffRole(role) && place.claimed_by_member_id !== memberId) {
          throw new NotHoursEditorException();
        }
        const updated = await this.repo.setClosedToday(tx, entity, id, closed);
        if (!updated) throw new NotHoursEditorException();
        const states = await this.repo.openStates(tx, entity, [id]);
        return {
          closedUntil: updated.closedUntil?.toISOString() ?? null,
          openState: states.get(id) ?? null,
        };
      }),
    );
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * Locks the row under its UPDATE policy (place: staff, agents, the claimed
   * owner; store: its managers, staff). 403 when the caller can see it but
   * not edit it, 404 when it doesn't exist. Returns the place row, if a place.
   */
  private async lockEditable(tx: DatabaseTransaction, entity: HoursEntity, id: string) {
    if (entity === 'place') {
      const row = await this.repo.findPlace(tx, id, { forUpdate: true });
      if (row) return row;
      if (await this.repo.findPlace(tx, id)) throw new NotHoursEditorException();
      throw new HoursEntityNotFoundException();
    }
    const store = await this.repo.findStore(tx, id, { forUpdate: true });
    if (store) return undefined;
    if (await this.repo.findStore(tx, id)) throw new NotHoursEditorException();
    throw new HoursEntityNotFoundException();
  }

  private async tenantOf(entity: HoursEntity, id: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.tenantOf(tx, entity, id), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new HoursEntityNotFoundException();
    return tenantId;
  }

  private requireUserId(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}

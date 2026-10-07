import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0044 (ADR 049): is_open_at — the one open/closed implementation —
 * at fixed instants, in the owning tenant's own time zone. Friday 2026-10-09
 * (ISO day 5); Dhaka is UTC+6, Kolkata UTC+5:30. Default settings: opens/
 * closes soon within 30 minutes, look 8 days ahead.
 */

const FIXTURE = '0191e3a0-a0a5-7000-8000-%';
const PARTNER = '0191e3a0-a0a5-7000-8000-000000000001';
const AREA_D = '0191e3a0-a0a5-7000-8000-000000000011';
const AREA_K = '0191e3a0-a0a5-7000-8000-000000000012';
const DHAKA = '0191e3a0-a0a5-7000-8000-000000000021';
const KOLKATA = '0191e3a0-a0a5-7000-8000-000000000022';
const OWNER = '0191e3a0-a0a5-7000-8000-000000000031';
const MEMBER = '0191e3a0-a0a5-7000-8000-000000000032';
const M_OWNER = '0191e3a0-a0a5-7000-8000-000000000041';
const M_MEMBER = '0191e3a0-a0a5-7000-8000-000000000042';
const CATEGORY = '0191e3a0-a0a5-7000-8000-000000000051';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 21.0,${east} 21.0,${east} 21.1,${west} 21.1,${west} 21.0)))`;

type Context = Record<string, string>;
const AS_OWNER: Context = { tenant_id: DHAKA, user_id: OWNER, member_id: M_OWNER, role: 'member' };
const AS_MEMBER: Context = {
  tenant_id: DHAKA,
  user_id: MEMBER,
  member_id: M_MEMBER,
  role: 'member',
};

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

async function stateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

let next = 0x1000;
const newId = () => `0191e3a0-a0a5-7000-8000-${(next++).toString(16).padStart(12, '0')}`;

type Range = [day: number, opens: string, closes: string, nextDay?: boolean];
const EVERY_DAY = (opens: string, closes: string, nextDay = false): Range[] =>
  [1, 2, 3, 4, 5, 6, 7].map((d) => [d, opens, closes, nextDay]);

describe('Business hours and open now (0044)', () => {
  let admin: Sql;
  let app: Sql;

  const place = async (
    hours: Range[],
    extra: { tenant?: string; status?: string; closedUntil?: string; claimedBy?: string } = {},
  ): Promise<string> => {
    const id = newId();
    const tenant = extra.tenant ?? DHAKA;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into places (id, tenant_id, category_id, slug, name_bn, status_code, location, source_code,
                            closed_until, claimed_by_member_id)
        values (${id}, ${tenant}, ${CATEGORY}, ${`hours-${id.slice(-6)}`}, 'দোকান', ${extra.status ?? 'published'},
                'SRID=4326;POINT(92.45 21.05)', 'agent_survey', ${extra.closedUntil ?? null}, ${extra.claimedBy ?? null})`;
      for (const [day, opens, closes, nextDay] of hours) {
        await tx`
          insert into place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
          values (${tenant}, ${id}, ${day}, ${opens}, ${closes}, ${nextDay ?? false})`;
      }
    });
    return id;
  };

  const exception = (
    placeId: string,
    onDate: string,
    range: [string, string] | 'closed',
    tenant = DHAKA,
  ) =>
    admin`
      insert into hours_exceptions (tenant_id, place_id, on_date, is_closed, opens_at, closes_at)
      values (${tenant}, ${placeId}, ${onDate}, ${range === 'closed'},
              ${range === 'closed' ? null : range[0]}, ${range === 'closed' ? null : range[1]})`;

  /** is_open_at as the app sees it: state and changes_at (ISO, UTC). */
  const at = async (type: 'place' | 'store', id: string, instant: string) => {
    const [row] = await as(
      app,
      AS_MEMBER,
      (tx) => tx<{ state: string; changes_at: Date | null }[]>`
      select (o).state, (o).changes_at
      from (select is_open_at(${type}, ${id}, ${instant}::timestamptz) as o) x`,
    );
    return { state: row!.state, changesAt: row!.changes_at?.toISOString() ?? null };
  };
  const utc = (instant: string) => new Date(instant).toISOString();

  async function cleanUp(): Promise<void> {
    const ids = (
      await admin<{ id: string }[]>`
        select id from places where tenant_id::text like ${FIXTURE}
        union all select id from stores where tenant_id::text like ${FIXTURE}`
    ).map((r) => r.id);
    await admin`delete from hours_exceptions where tenant_id::text like ${FIXTURE}`;
    await admin`delete from store_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`update places set claimed_by_member_id = null where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    if (ids.length > 0) await admin`delete from outbox_events where aggregate_id in ${admin(ids)}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values (${OWNER}, '+8801788000001'), (${MEMBER}, '+8801788000002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Hours Partner', 'Hours Partner', '+8801788000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_D}, 3, 'upazila', 'hours-d', 'Hours D', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_K}, 3, 'upazila', 'hours-k', 'Hours K', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code, timezone)
      values (${DHAKA}, ${PARTNER}, ${AREA_D}, 'hours-d', 'ঢাকা', 'Dhaka', 'SRID=4326;POINT(92.45 21.05)', 'active', 'Asia/Dhaka'),
             (${KOLKATA}, ${PARTNER}, ${AREA_K}, 'hours-k', 'কলকাতা', 'Kolkata', 'SRID=4326;POINT(92.55 21.05)', 'active', 'Asia/Kolkata')`;
    await admin`insert into tenant_settings (tenant_id) values (${DHAKA}), (${KOLKATA})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${DHAKA}, ${OWNER}, 'member'), (${M_MEMBER}, ${DHAKA}, ${MEMBER}, 'member')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en) values (${CATEGORY}, 'place', 'hours-shop', 'দোকান', 'Shop')`;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  it('a place with no hours is unknown, never closed', async () => {
    const id = await place([]);
    expect(await at('place', id, '2026-10-09 11:00+06')).toEqual({
      state: 'unknown',
      changesAt: null,
    });
  });

  it('a split shift (closed for Jummah): open, closes soon, closed, opens soon', async () => {
    const id = await place([
      [5, '09:00', '12:30'],
      [5, '14:30', '21:00'],
    ]);
    expect(await at('place', id, '2026-10-09 11:00+06')).toEqual({
      state: 'open',
      changesAt: utc('2026-10-09 12:30+06'),
    });
    expect((await at('place', id, '2026-10-09 12:10+06')).state).toBe('closes_soon');
    expect(await at('place', id, '2026-10-09 13:00+06')).toEqual({
      state: 'closed',
      changesAt: utc('2026-10-09 14:30+06'),
    });
    expect((await at('place', id, '2026-10-09 14:10+06')).state).toBe('opens_soon');
    // After Friday's last range: next Friday morning.
    expect(await at('place', id, '2026-10-09 22:00+06')).toEqual({
      state: 'closed',
      changesAt: utc('2026-10-16 09:00+06'),
    });
  });

  it('an overnight range is open after midnight, and touching ranges count as one', async () => {
    const id = await place(EVERY_DAY('18:00', '02:00', true));
    // Saturday 01:00 is inside Friday's 18:00–02:00.
    expect(await at('place', id, '2026-10-10 01:00+06')).toEqual({
      state: 'open',
      changesAt: utc('2026-10-10 02:00+06'),
    });
    expect(await at('place', id, '2026-10-10 03:00+06')).toEqual({
      state: 'closed',
      changesAt: utc('2026-10-10 18:00+06'),
    });

    const split = await place([
      [5, '22:00', '00:00', true],
      [6, '00:00', '02:00'],
    ]);
    expect(await at('place', split, '2026-10-09 23:50+06')).toEqual({
      state: 'open',
      changesAt: utc('2026-10-10 02:00+06'),
    });
  });

  it('a holiday overrides the week, and a special day has its own hours', async () => {
    const id = await place(EVERY_DAY('09:00', '21:00'));
    await exception(id, '2026-10-09', 'closed');
    await exception(id, '2026-10-10', ['10:00', '14:00']);
    expect(await at('place', id, '2026-10-09 10:00+06')).toEqual({
      state: 'closed',
      // Saturday's special hours, not the usual 09:00.
      changesAt: utc('2026-10-10 10:00+06'),
    });
    expect((await at('place', id, '2026-10-10 09:40+06')).state).toBe('opens_soon');
    expect(await at('place', id, '2026-10-10 12:00+06')).toEqual({
      state: 'open',
      changesAt: utc('2026-10-10 14:00+06'),
    });
    // Sunday is an ordinary day again.
    expect((await at('place', id, '2026-10-11 20:00+06')).state).toBe('open');
  });

  it('"closed today" closes it until the toggle ends, then the schedule takes over', async () => {
    const id = await place(EVERY_DAY('09:00', '21:00'), { closedUntil: '2026-10-10 00:00+06' });
    expect(await at('place', id, '2026-10-09 10:00+06')).toEqual({
      state: 'closed',
      changesAt: utc('2026-10-10 09:00+06'),
    });
    expect((await at('place', id, '2026-10-10 10:00+06')).state).toBe('open');

    // Closed until 15:00, inside a range: it reopens at 15:00.
    const back = await place(EVERY_DAY('09:00', '21:00'), { closedUntil: '2026-10-09 15:00+06' });
    expect(await at('place', back, '2026-10-09 14:40+06')).toEqual({
      state: 'opens_soon',
      changesAt: utc('2026-10-09 15:00+06'),
    });
    // Even without hours, the owner's "closed today" is closed, not unknown.
    const bare = await place([], { closedUntil: '2026-10-10 00:00+06' });
    expect((await at('place', bare, '2026-10-09 10:00+06')).state).toBe('closed');
  });

  it("is computed in the owning tenant's own zone", async () => {
    const id = await place([[5, '09:00', '17:00']], { tenant: KOLKATA });
    // 03:20 UTC = 08:50 in Kolkata (09:20 in Dhaka): not open yet there.
    expect(await at('place', id, '2026-10-09 03:20Z')).toEqual({
      state: 'opens_soon',
      changesAt: utc('2026-10-09 09:00+05:30'),
    });
    expect(
      await stateOf(admin`update tenants set timezone = 'Mars/Olympus' where id = ${KOLKATA}`),
    ).toBe('23514');
  });

  it('a temporarily closed place is closed whatever its hours', async () => {
    const id = await place(EVERY_DAY('00:00', '00:00', true), { status: 'temporarily_closed' });
    expect(await at('place', id, '2026-10-09 12:00+06')).toEqual({
      state: 'closed',
      changesAt: null,
    });
  });

  it("a store uses its own hours, or its place's when it has none", async () => {
    const pin = await place(EVERY_DAY('09:00', '21:00'));
    const pinned = newId();
    const own = newId();
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, place_id, slug, name_bn, status_code, location) values
        (${pinned}, ${DHAKA}, ${M_OWNER}, ${pin}, ${`hs-${pinned.slice(-6)}`}, 'পিন', 'active', 'SRID=4326;POINT(92.45 21.05)'),
        (${own}, ${DHAKA}, ${M_OWNER}, null, ${`hs-${own.slice(-6)}`}, 'নিজের', 'active', 'SRID=4326;POINT(92.451 21.05)')`;
      await tx`insert into store_hours (tenant_id, store_id, iso_day_of_week, opens_at, closes_at)
               values (${DHAKA}, ${own}, 5, '16:00', '20:00')`;
    });
    expect((await at('store', pinned, '2026-10-09 10:00+06')).state).toBe('open');
    expect((await at('store', own, '2026-10-09 10:00+06')).state).toBe('closed');
    expect((await at('store', own, '2026-10-09 17:00+06')).state).toBe('open');

    const states = await as(
      app,
      AS_MEMBER,
      (tx) => tx<{ id: string; state: string }[]>`
      select id, state from open_states('store', ${[pinned, own]}::uuid[], '2026-10-09 10:00+06') order by state`,
    );
    expect(states).toEqual([
      { id: own, state: 'closed' },
      { id: pinned, state: 'open' },
    ]);
  });

  it('open_ids_near keeps only what is open, within the radius', async () => {
    const open = await place(EVERY_DAY('00:00', '00:00', true));
    const shut = await place([], { closedUntil: '2099-01-01 00:00+06' });
    const ids = await as(app, AS_MEMBER, async (tx) =>
      (
        await tx<
          { id: string }[]
        >`select id from open_ids_near('place', 21.05, 92.45, 500, now(), 1000)`
      ).map((r) => r.id),
    );
    expect(ids).toContain(open);
    expect(ids).not.toContain(shut);
  });

  it('feed_landmarks(…, open_only) keeps only open landmarks', async () => {
    const open = await place(EVERY_DAY('00:00', '00:00', true));
    const unknown = await place([]);
    await admin.begin(async (tx) => {
      // Landmark flags are staff-only (places_protect_landmark_columns, 0005).
      await tx`select set_config('app.role', 'moderator', true)`;
      await tx`update places set is_landmark = true where id in (${open}, ${unknown})`;
    });
    const landmarks = (openOnly: boolean) =>
      as(app, AS_MEMBER, async (tx) =>
        (
          await tx<{ id: string }[]>`
            select id from feed_landmarks('SRID=4326;POINT(92.45 21.05)'::geography, 50, ${openOnly})`
        ).map((r) => r.id),
      );
    expect(await landmarks(false)).toEqual(expect.arrayContaining([open, unknown]));
    const onlyOpen = await landmarks(true);
    expect(onlyOpen).toContain(open);
    expect(onlyOpen).not.toContain(unknown);
  });

  it("is_open_at's lookups by place or store id have an index (0049: they scanned the table)", async () => {
    // The lookups is_open_at / hours_intervals run: by entity id, no tenant.
    const lookups = [
      `select 1 from place_hours h where h.place_id = '${randomUUID()}'`,
      `select 1 from store_hours h where h.store_id = '${randomUUID()}'`,
      `select 1 from hours_exceptions e
       where (e.place_id = '${randomUUID()}' or e.store_id = '${randomUUID()}')
         and e.on_date between current_date - 1 and current_date + 7`,
    ];
    const plans = await admin.begin(async (tx) => {
      // Too few rows here for the planner to prefer an index on its own:
      // ask whether one is usable at all.
      await tx`set local enable_seqscan = off`;
      return Promise.all(
        lookups.map(async (q) =>
          (await tx.unsafe<{ 'QUERY PLAN': string }[]>(`explain ${q}`))
            .map((r) => r['QUERY PLAN'])
            .join('\n'),
        ),
      );
    });
    expect(plans[0]).toContain('place_hours_place_day_idx');
    expect(plans[1]).toContain('store_hours_store_day_idx');
    expect(plans[2]).toContain('hours_exceptions_place_on_date_idx');
    expect(plans[2]).toContain('hours_exceptions_store_on_date_idx');
  });

  describe('RLS', () => {
    it("special days are written by the place's editors only", async () => {
      const mine = await place(EVERY_DAY('09:00', '21:00'), { claimedBy: M_OWNER });
      const write = (context: Context) =>
        as(
          app,
          context,
          (tx) => tx`
          insert into hours_exceptions (place_id, on_date, is_closed) values (${mine}, '2026-12-16', true)`,
        );
      expect(await stateOf(write(AS_MEMBER))).toBe('42501');
      expect(await stateOf(write(AS_OWNER))).toBeUndefined();
      // Everyone reads it with the published place.
      const seen = await as(
        app,
        AS_MEMBER,
        (tx) => tx`select on_date from hours_exceptions where place_id = ${mine}`,
      );
      expect(seen).toHaveLength(1);
    });

    it("store hours are the store managers' and staff's", async () => {
      const store = newId();
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
                 values (${store}, ${DHAKA}, ${M_OWNER}, ${`hs-${store.slice(-6)}`}, 'দোকান', 'active')`;
      });
      const write = (context: Context) =>
        as(
          app,
          context,
          (tx) => tx`
          insert into store_hours (store_id, iso_day_of_week, opens_at, closes_at) values (${store}, 1, '09:00', '17:00')`,
        );
      expect(await stateOf(write(AS_MEMBER))).toBe('42501');
      expect(await stateOf(write(AS_OWNER))).toBeUndefined();
    });
  });
});

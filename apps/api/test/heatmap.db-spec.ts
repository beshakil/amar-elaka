import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * heatmap_cells (0045, ADR 050), as ae_app: demand and supply per geohash
 * cell of the current tenant only, never a cell with fewer than the minimum
 * of DISTINCT people (one person searching many times can't light a cell
 * up), old searches out of the window, the category filter, and only tenant
 * admins (and platform staff) may ask.
 */

const FIXTURE = '0191e3a0-4ea7-7000-8000-%';
const PARTNER = '0191e3a0-4ea7-7000-8000-000000000001';
const AREA = '0191e3a0-4ea7-7000-8000-000000000011';
const AREA_B = '0191e3a0-4ea7-7000-8000-000000000012';
const TENANT = '0191e3a0-4ea7-7000-8000-000000000021';
const TENANT_B = '0191e3a0-4ea7-7000-8000-000000000022';
const ADMIN = '0191e3a0-4ea7-7000-8000-000000000031';
const M_ADMIN = '0191e3a0-4ea7-7000-8000-000000000041';
const CATEGORY = '0191e3a0-4ea7-7000-8000-000000000051';
const OTHER_CATEGORY = '0191e3a0-4ea7-7000-8000-000000000052';
const SCHEMA = '0191e3a0-4ea7-7000-8000-000000000061';
const userId = (n: number) =>
  `0191e3a0-4ea7-7000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const memberId = (n: number) =>
  `0191e3a0-4ea7-7000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;

const square = (west: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 22.5,${west + 0.1} 22.5,${west + 0.1} 22.6,${west} 22.6,${west} 22.5)))`;
// Busy: geohash-6 cell around (22.55, 92.05); Lonely: another cell 2 km away.
const BUSY = (i: number) => `SRID=4326;POINT(${92.0501 + i * 0.0001} 22.5501)`;
const LONELY = 'SRID=4326;POINT(92.07 22.57)';

type Context = Record<string, string>;
const AS_ADMIN: Context = {
  tenant_id: TENANT,
  user_id: ADMIN,
  member_id: M_ADMIN,
  role: 'tenant_admin',
};
const AS_MEMBER: Context = {
  tenant_id: TENANT,
  user_id: userId(1),
  member_id: memberId(1),
  role: 'member',
};
const AS_ADMIN_B: Context = { tenant_id: TENANT_B, user_id: ADMIN, role: 'tenant_admin' };

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

interface Cell {
  geohash: string;
  lat: number;
  lng: number;
  count: number;
  people: number;
}

describe('heatmap_cells (0045)', () => {
  let admin: Sql;
  let app: Sql;

  const cells = (context: Context, type: 'demand' | 'supply', category: string | null = null) =>
    as(
      app,
      context,
      (tx) => tx<Cell[]>`
      select geohash, lat, lng, count, people from heatmap_cells(${type}, ${category}, 6, 30, 5, 100)`,
    );

  async function cleanUp(): Promise<void> {
    const ids = (
      await admin<{ id: string }[]>`select id from posts where tenant_id::text like ${FIXTURE}`
    ).map((r) => r.id);
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_searches where user_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    if (ids.length > 0) await admin`delete from outbox_events where aggregate_id in ${admin(ids)}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  const search = (
    person: number,
    point: string,
    extra: { daysAgo?: number; category?: string; anonymous?: boolean } = {},
  ) =>
    admin`
      insert into search_queries (tenant_id, user_id, searcher_hash, q_normalized, filters_hash, result_count,
                                  origin, category_id, created_at)
      values (${TENANT}, ${extra.anonymous ? null : userId(person)}, ${person.toString(16).padStart(64, '0')},
              'flat', '0123456789abcdef', 3, ${point}, ${extra.category ?? null},
              now() - make_interval(days => ${extra.daysAgo ?? 1}))`;

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values (${ADMIN}, '+8801766600000')`;
    for (let n = 1; n <= 8; n++) {
      await admin`insert into users (id, phone_e164) values (${userId(n)}, ${`+88017666000${n.toString().padStart(2, '0')}`})`;
    }
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Heat Partner', 'Heat Partner', '+8801766699999')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'heat-a', 'Heat A', 'fixture', ${square(92.0)}, ${square(92.0)}),
             (${AREA_B}, 3, 'upazila', 'heat-b', 'Heat B', 'fixture', ${square(92.1)}, ${square(92.1)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'heat-a', 'এ', 'A', 'SRID=4326;POINT(92.05 22.55)', 'active'),
             (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'heat-b', 'বি', 'B', 'SRID=4326;POINT(92.15 22.55)', 'active')`;
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M_ADMIN}, ${TENANT}, ${ADMIN}, 'tenant_admin')`;
    for (let n = 1; n <= 8; n++) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${memberId(n)}, ${TENANT}, ${userId(n)}, 'member')`;
    }
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'heat-flats', 'ফ্ল্যাট', 'Flats'),
        (${OTHER_CATEGORY}, 'marketplace', 'heat-cars', 'গাড়ি', 'Cars')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;

    // Demand. BUSY: four people, two of them twice, plus one anonymous searcher and
    // a fifth person's saved search = 6 people. LONELY: one person, 12 searches.
    for (let n = 1; n <= 4; n++) await search(n, BUSY(n), { category: CATEGORY });
    await search(1, BUSY(5), { category: CATEGORY });
    await search(2, BUSY(6), { category: OTHER_CATEGORY });
    await search(99, BUSY(7), { anonymous: true });
    await admin`
      insert into saved_searches (user_id, name, center, category_id)
      values (${userId(5)}, 'flats', ${BUSY(8)}, ${CATEGORY})`;
    for (let i = 0; i < 12; i++) await search(6, LONELY);
    // Out of the window: doesn't count.
    await search(7, BUSY(9), { daysAgo: 60 });

    // Supply: five sellers' live posts in BUSY; one seller's three posts in LONELY.
    const post = (member: string, point: string, status = 'live') =>
      admin`
        insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
                           published_at, location, price_type_code, fields)
        values (${TENANT}, ${member}, ${CATEGORY}, ${SCHEMA}, 'ফ্ল্যাট ভাড়া', ${status},
                ${status === 'live' ? new Date() : null}, ${point}, 'fixed', '{"price": "100.00"}'::jsonb)`;
    for (let n = 1; n <= 5; n++) await post(memberId(n), BUSY(n));
    await post(memberId(6), BUSY(6), 'draft');
    for (let i = 0; i < 3; i++) await post(memberId(7), LONELY);
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  it('demand: a cell needs five different people; one person searching twelve times is not enough', async () => {
    const demand = await cells(AS_ADMIN, 'demand');
    expect(demand).toHaveLength(1);
    const [busy] = demand;
    // 4 + 1 (repeat) + 1 + 1 (anonymous) searches + 1 saved search; 6 people.
    expect(busy).toMatchObject({ count: 8, people: 6 });
    expect(busy!.geohash).toHaveLength(6);
    // The cell's centre, not anybody's point.
    expect(Math.abs(busy!.lat - 22.5501)).toBeLessThan(0.01);
    expect(busy!.lat).not.toBe(22.5501);
  });

  it("demand by category: that category's searches and alerts only", async () => {
    // Flats: people 1–4 (one of them twice) and person 5's alert = 6 events, 5 people.
    const flats = await cells(AS_ADMIN, 'demand', 'heat-flats');
    expect(flats).toHaveLength(1);
    expect(flats[0]).toMatchObject({ count: 6, people: 5 });
    // Cars: one person — never shown.
    expect(await cells(AS_ADMIN, 'demand', 'heat-cars')).toEqual([]);
  });

  it("supply: live posts by five sellers make a cell; one seller's three posts do not, drafts never", async () => {
    const supply = await cells(AS_ADMIN, 'supply');
    expect(supply).toHaveLength(1);
    expect(supply[0]).toMatchObject({ count: 5, people: 5 });
    expect(await cells(AS_ADMIN, 'supply', 'heat-flats')).toHaveLength(1);
    expect(await cells(AS_ADMIN, 'supply', 'heat-cars')).toEqual([]);
  });

  it('owns saved searches by resolve_owning_tenant, like unmet demand: just outside the polygon still counts (0048)', async () => {
    // 2 km west of tenant A's square: outside its polygon, inside the 5 km
    // boundary buffer, nearest to A. The old polygon test left it out.
    const OUTSIDE = 'SRID=4326;POINT(91.981 22.5501)';
    for (const n of [6, 7]) {
      await admin`
        insert into saved_searches (user_id, name, center)
        values (${userId(n)}, 'buffer', ${OUTSIDE})`;
    }
    try {
      const rows = await as(
        app,
        AS_ADMIN,
        (tx) => tx<Cell[]>`
          select geohash, lat, lng, count, people from heatmap_cells('demand', null, 6, 30, 2, 100)`,
      );
      const west = rows.find((c) => c.lng < 92.0);
      expect(west).toMatchObject({ people: 2 });
      // Tenant B (east of A) never gets it.
      expect(
        (
          await as(
            app,
            AS_ADMIN_B,
            (tx) => tx<Cell[]>`
            select geohash, lat, lng, count, people from heatmap_cells('demand', null, 6, 30, 2, 100)`,
          )
        ).find((c) => c.lng < 92.0),
      ).toBeUndefined();
    } finally {
      await admin`delete from saved_searches where name = 'buffer' and user_id::text like ${FIXTURE}`;
    }
  });

  it('supply leaves out a live post past expires_at (0048)', async () => {
    const before = (await cells(AS_ADMIN, 'supply'))[0]!;
    await admin`
      update posts set expires_at = now() - interval '1 minute'
      where tenant_id = ${TENANT} and author_member_id = ${memberId(1)}`;
    try {
      // One of the five sellers gone: the busy cell drops below five people.
      expect(await cells(AS_ADMIN, 'supply')).toEqual([]);
      expect(before.people).toBe(5);
    } finally {
      await admin`update posts set expires_at = null where tenant_id = ${TENANT} and author_member_id = ${memberId(1)}`;
    }
  });

  it("is the tenant's own data, for its admins only", async () => {
    expect(await cells(AS_ADMIN_B, 'demand')).toEqual([]);
    await expect(cells(AS_MEMBER, 'demand')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a minimum below two', async () => {
    await expect(
      as(app, AS_ADMIN, (tx) => tx`select * from heatmap_cells('demand', null, 6, 30, 1, 100)`),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

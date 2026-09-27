import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql, TransactionSql } from 'postgres';
import { AppModule } from '../src/app.module';
import { CacheService } from '../src/cache/cache.service';
import type { FeedItem, FeedResponse } from '../src/feed/dto/feed.dto';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * GET /api/v1/feed end to end (ADR 035): ranking in feed_posts, cards read in
 * each owning tenant's context, the mixed layout, the cursor and the
 * first-page cache. Needs Postgres (migrated) and Redis, like posts.e2e-spec.
 *
 * Two adjacent upazilas near Khulna (away from other suites' fixtures),
 * sharing the edge at lng 89.10; the viewer stands in A at lng 89.08.
 */

const FIXTURE = '0191e3a0-fee1-7000-8000-%';
const PARTNER = '0191e3a0-fee1-7000-8000-000000000001';
const AREA_A = '0191e3a0-fee1-7000-8000-000000000011';
const AREA_B = '0191e3a0-fee1-7000-8000-000000000012';
const TENANT_A = '0191e3a0-fee1-7000-8000-000000000021';
const TENANT_B = '0191e3a0-fee1-7000-8000-000000000022';
const USER_A = '0191e3a0-fee1-7000-8000-000000000031';
const USER_B = '0191e3a0-fee1-7000-8000-000000000032';
const MEMBER_A = '0191e3a0-fee1-7000-8000-000000000041';
const MEMBER_B = '0191e3a0-fee1-7000-8000-000000000042';
const CATEGORY = '0191e3a0-fee1-7000-8000-000000000051';
const CATEGORY_PLACE = '0191e3a0-fee1-7000-8000-000000000053';
const SCHEMA = '0191e3a0-fee1-7000-8000-000000000061';
const BOOST_TYPE = '0191e3a0-fee1-7000-8000-000000000071';
const HOTLINE = '0191e3a0-fee1-7000-8000-000000000081';
const COMMODITY = '0191e3a0-fee1-7000-8000-000000000091';

const LAT = 22.5;
const VIEWER = { lat: LAT, lng: 89.08 };
const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 22.45,${east} 22.45,${east} 22.55,${west} 22.55,${west} 22.45)))`;
const point = (lng: number) => `SRID=4326;POINT(${lng} ${LAT})`;

async function as<T>(sql: Sql, role: string, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.role', ${role}, true)`;
    return work(tx);
  }) as Promise<T>;
}

let nextId = 0x1000;
const fixtureId = () => `0191e3a0-fee1-7000-8000-${(nextId++).toString(16).padStart(12, '0')}`;

describe('Feed (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const postsA: string[] = [];
  let postB: string;
  let boostedPost: string;
  let draftPost: string;
  let storeB: string;
  let landmarkB: string;

  const get = async (query: Record<string, string | number>, tenant = TENANT_A) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed',
      query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      headers: { 'x-tenant-id': tenant },
    });
    return {
      status: response.statusCode,
      body: response.json<FeedResponse & { error?: string }>(),
    };
  };

  const kinds = (items: FeedItem[]) => items.map((item) => item.kind);
  const postIds = (items: FeedItem[]) =>
    items.flatMap((item) => (item.kind === 'post' ? [item.id] : []));

  async function cleanUp(): Promise<void> {
    await admin`delete from boosts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from bazar_prices where tenant_id::text like ${FIXTURE}`;
    await admin`delete from bazar_commodities where id::text like ${FIXTURE}`;
    await admin`delete from national_hotlines where id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from boost_types where id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
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
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${USER_A}, '+8801799200001'), (${USER_B}, '+8801799200002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Feed E2E Partner', 'Feed E2E Partner', '+8801799200099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'feed-e2e-a', 'Feed E2E A', 'ফিড এ', 'fixture', ${square(89.0, 89.1)}, ${square(89.0, 89.1)}),
        (${AREA_B}, 3, 'upazila', 'feed-e2e-b', 'Feed E2E B', 'ফিড বি', 'fixture', ${square(89.1, 89.2)}, ${square(89.1, 89.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'feed-e2e-a', 'এ', 'A', ${point(89.05)}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'feed-e2e-b', 'বি', 'B', ${point(89.15)}, 'active')`;
    // Small pages so the store rhythm, info slots and paging all show up.
    await admin`
      insert into tenant_settings (tenant_id, setting_overrides) values
        (${TENANT_A}, ${admin.json({
          feed_store_card_interval: 2,
          feed_emergency_card_position: 1,
          feed_bazar_card_position: 3,
          feed_landmark_card_position: 50,
        })}),
        (${TENANT_B}, '{}'::jsonb)`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'), (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'feed-e2e-category', 'বিভাগ', 'Category'),
        (${CATEGORY_PLACE}, 'place', 'feed-e2e-place', 'হাসপাতাল', 'Hospital')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;

    const post = async (
      tenant: string,
      member: string,
      lng: number,
      extra: { status?: string; priceType?: string } = {},
    ) => {
      const id = fixtureId();
      await admin`
        insert into posts
          (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
           published_at, bumped_at, location, geo_area_id, price_type_code, fields)
        values
          (${id}, ${tenant}, ${member}, ${CATEGORY}, ${SCHEMA}, ${`feed post ${id.slice(-4)}`},
           ${extra.status ?? 'live'}, now() - interval '1 hour', now() - interval '1 hour',
           ${point(lng)}, ${tenant === TENANT_A ? AREA_A : AREA_B}, ${extra.priceType ?? 'fixed'},
           '{"price": "1500.00"}'::jsonb)`;
      return id;
    };
    for (let i = 0; i < 5; i += 1) postsA.push(await post(TENANT_A, MEMBER_A, 89.07 + i * 0.001));
    postB = await post(TENANT_B, MEMBER_B, 89.11, { priceType: 'negotiable' }); // ~3 km, across the edge
    draftPost = await post(TENANT_A, MEMBER_A, 89.08, { status: 'draft' });
    boostedPost = postsA[4]!;

    await admin`
      insert into boost_types
        (id, code, name_key, placement_code, target_code, duration_hours, default_cost_credits, min_cost_credits, max_cost_credits)
      values (${BOOST_TYPE}, 'feed-e2e-home', 'enum.boost_types.fixture', 'home_featured', 'post', 24, 50, 10, 200)`;
    await admin`
      insert into boosts
        (tenant_id, boost_type_id, post_id, purchased_by_member_id, starts_at, ends_at, cost_credits, status_code)
      values (${TENANT_A}, ${BOOST_TYPE}, ${boostedPost}, ${MEMBER_A}, now() - interval '1 hour',
              now() + interval '1 day', 0, 'active')`;

    storeB = fixtureId();
    landmarkB = fixtureId();
    await as(admin, 'moderator', async (tx) => {
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, location, status_code, is_verified)
        values (${storeB}, ${TENANT_B}, ${MEMBER_B}, 'feed-e2e-store', 'দোকান বি', ${point(89.105)}, 'active', true)`;
      await tx`
        insert into places
          (id, tenant_id, category_id, slug, name_bn, location, source_code, status_code, is_landmark, landmark_radius_km)
        values (${landmarkB}, ${TENANT_B}, ${CATEGORY_PLACE}, 'feed-e2e-hospital', 'জেলা হাসপাতাল',
                ${point(89.19)}, 'user_submitted', 'published', true, 20)`;
    });

    await admin`
      insert into national_hotlines (id, service_type_code, name_bn, name_en, dial_string, sort_order)
      values (${HOTLINE}, 'police', 'জাতীয় জরুরি সেবা', 'National emergency', '999', -1000)`;
    await admin`
      insert into bazar_commodities (id, code, name_bn, name_en, group_code, default_unit_code)
      values (${COMMODITY}, 'feed-e2e-rice', 'চাল', 'Rice', 'rice_grains', 'kg')`;
    await as(
      admin,
      'moderator',
      (tx) => tx`
      insert into bazar_prices (tenant_id, commodity_id, price_date, unit_code, min_price, max_price, source_code, status_code)
      values (${TENANT_A}, ${COMMODITY}, (now() at time zone 'Asia/Dhaka')::date, 'kg', 60, 65, 'staff', 'published')`,
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app?.close();
    }
  });

  it('mixes ranked posts, a store card, info cards and landmarks across the boundary', async () => {
    const { status, body } = await get({ ...VIEWER, scope: 'area', limit: 10 });
    expect(status).toBe(200);
    expect(body.scope).toBe('area');
    expect(body.radiusKm).toBe(5);

    const ids = postIds(body.items);
    expect(ids.sort()).toEqual([...postsA, postB].sort());
    expect(ids).not.toContain(draftPost);

    // Emergency at slot 1, bazar at slot 3, store after every 2 posts, landmark appended.
    expect(body.items[0]).toMatchObject({
      kind: 'emergency',
      hotlines: [expect.objectContaining({ dial: '999', serviceType: 'police' })],
    });
    expect(body.items[2]).toMatchObject({
      kind: 'bazar_prices',
      items: [{ commodity: 'feed-e2e-rice', unit: 'kg', minPrice: '60.00', maxPrice: '65.00' }],
    });
    expect(kinds(body.items).filter((k) => k === 'store')).toHaveLength(1);
    expect(body.items.find((i) => i.kind === 'store')).toMatchObject({
      id: storeB,
      tenantId: TENANT_B,
      isVerified: true,
    });
    expect(body.items.at(-1)).toMatchObject({
      kind: 'landmark',
      id: landmarkB,
      tenantId: TENANT_B,
    });

    // Six posts, a page limit of 10: no next page.
    expect(body.nextCursor).toBeNull();
  });

  it('returns card fields only, read in the owning tenant', async () => {
    const { body } = await get({ ...VIEWER, limit: 10 });
    const cardB = body.items.find((i) => i.kind === 'post' && i.id === postB);
    expect(cardB).toEqual({
      kind: 'post',
      id: postB,
      tenantId: TENANT_B,
      title: expect.any(String) as unknown,
      price: '1500.00',
      cover: null,
      distanceMeters: expect.any(Number) as unknown,
      area: { bn: 'ফিড বি', en: 'Feed E2E B' },
      badges: ['negotiable'],
      createdAt: expect.any(String) as unknown,
    });
    const boosted = body.items.find((i) => i.kind === 'post' && i.id === boostedPost);
    expect(boosted).toMatchObject({ badges: ['boosted'] });
    // The boosted post ranks first among posts.
    expect(postIds(body.items)[0]).toBe(boostedPost);
  });

  it('pages with a cursor, info cards on the first page only', async () => {
    const first = await get({ ...VIEWER, limit: 4 });
    expect(postIds(first.body.items)).toHaveLength(4);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await get({ ...VIEWER, limit: 4, cursor: first.body.nextCursor! });
    expect(second.status).toBe(200);
    const all = [...postIds(first.body.items), ...postIds(second.body.items)];
    expect(all.sort()).toEqual([...postsA, postB].sort());
    expect(kinds(second.body.items)).not.toContain('emergency');
    expect(kinds(second.body.items)).not.toContain('bazar_prices');
    expect(second.body.nextCursor).toBeNull();
  });

  it('rejects a cursor used with different parameters', async () => {
    const first = await get({ ...VIEWER, limit: 4 });
    const other = await get({
      ...VIEWER,
      limit: 4,
      scope: 'nearby',
      radius_km: 3,
      cursor: first.body.nextCursor!,
    });
    expect(other.status).toBe(400);
    expect(other.body.error).toBe('FEED_CURSOR_INVALID');
  });

  it('caps nearby at feed_max_radius_km and refuses a non-shippable category country-wide', async () => {
    const nearby = await get({ ...VIEWER, scope: 'nearby', radius_km: 400 });
    expect(nearby.body.radiusKm).toBe(25);

    const country = await get({ ...VIEWER, scope: 'country', category: 'feed-e2e-category' });
    expect(country.status).toBe(400);
    expect(country.body.error).toBe('FEED_CATEGORY_NOT_SHIPPABLE');
  });

  it('serves the first page from the cache within the TTL', async () => {
    const cache = app.get(CacheService);
    const spy = jest.spyOn(cache, 'set');
    const query = { ...VIEWER, limit: 7 };
    const first = await get(query);
    const setsAfterFirst = spy.mock.calls.length;
    const second = await get(query);
    expect(spy.mock.calls.length).toBe(setsAfterFirst);
    expect(second.body).toEqual(first.body);
    spy.mockRestore();
  });
});

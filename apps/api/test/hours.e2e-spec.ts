import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Business hours end to end (ADR 049): the open state on a place, special
 * days and "closed today" through the API, a store's own week, and
 * open_now on the feed and the map — all answered by is_open_at().
 * "Always open" = every day 00:00 → 00:00 next day, so the tests don't depend
 * on when they run.
 */

const FIXTURE = '0191e3a0-a0a6-7000-8000-%';
const PARTNER = '0191e3a0-a0a6-7000-8000-000000000001';
const AREA = '0191e3a0-a0a6-7000-8000-000000000011';
const TENANT = '0191e3a0-a0a6-7000-8000-000000000021';
const OWNER = '0191e3a0-a0a6-7000-8000-000000000031';
const AGENT = '0191e3a0-a0a6-7000-8000-000000000032';
const MEMBER = '0191e3a0-a0a6-7000-8000-000000000033';
const M_OWNER = '0191e3a0-a0a6-7000-8000-000000000041';
const M_AGENT = '0191e3a0-a0a6-7000-8000-000000000042';
const M_MEMBER = '0191e3a0-a0a6-7000-8000-000000000043';
const PLACE_CATEGORY = '0191e3a0-a0a6-7000-8000-000000000051';
const POST_CATEGORY = '0191e3a0-a0a6-7000-8000-000000000052';
const SCHEMA = '0191e3a0-a0a6-7000-8000-000000000061';
const ALWAYS = '0191e3a0-a0a6-7000-8000-000000000071';
const NO_HOURS = '0191e3a0-a0a6-7000-8000-000000000072';
const STORE_OPEN = '0191e3a0-a0a6-7000-8000-000000000081';
const STORE_UNKNOWN = '0191e3a0-a0a6-7000-8000-000000000082';

const square = `SRID=4326;MULTIPOLYGON(((92.4 21.3,92.5 21.3,92.5 21.4,92.4 21.4,92.4 21.3)))`;
const at = (lng: number) => `SRID=4326;POINT(${lng} 21.35)`;
const VIEWER = { lat: 21.35, lng: 92.45 };
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, opens: '00:00', closes: '00:00' }));
const localToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

interface OpenState {
  state: string;
  changesAt: string | null;
}

describe('Business hours and open now (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Record<'owner' | 'agent' | 'member', string> = { owner: '', agent: '', member: '' };

  async function cleanUp(): Promise<void> {
    const ids = (
      await admin<{ id: string }[]>`
        select id from places where tenant_id::text like ${FIXTURE}
        union all select id from stores where tenant_id::text like ${FIXTURE}
        union all select id from posts where tenant_id::text like ${FIXTURE}
        union all select id from tenant_categories where tenant_id::text like ${FIXTURE}`
    ).map((r) => r.id);
    await admin`delete from hours_exceptions where tenant_id::text like ${FIXTURE}`;
    await admin`delete from store_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`update places set claimed_by_member_id = null where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    if (ids.length > 0) await admin`delete from outbox_events where aggregate_id in ${admin(ids)}`;
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
        (${OWNER}, '+8801799000001'), (${AGENT}, '+8801799000002'), (${MEMBER}, '+8801799000003')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Hours Partner', 'Hours Partner', '+8801799000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'hours-e2e', 'Hours E2E', 'fixture', ${square}, ${square})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code, timezone)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'hours-e2e', 'সময়', 'Hours', ${at(92.45)}, 'active', 'Asia/Dhaka')`;
    await admin.begin(async (tx) => {
      // A store card after every post, so a handful of posts show the stores.
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`insert into tenant_settings (tenant_id, setting_overrides)
               values (${TENANT}, ${tx.json({ feed_store_card_interval: 1 })})`;
    });
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT}, ${OWNER}, 'member'), (${M_AGENT}, ${TENANT}, ${AGENT}, 'agent'),
        (${M_MEMBER}, ${TENANT}, ${MEMBER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${PLACE_CATEGORY}, 'place', 'hours-e2e-shop', 'দোকান', 'Shop'),
        (${POST_CATEGORY}, 'marketplace', 'hours-e2e-sale', 'বিক্রি', 'Sale')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${POST_CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into places (id, tenant_id, category_id, slug, name_bn, status_code, location, source_code, claimed_by_member_id)
        values (${ALWAYS}, ${TENANT}, ${PLACE_CATEGORY}, 'hours-always', 'সবসময় খোলা', 'published', ${at(92.4501)}, 'agent_survey', ${M_OWNER}),
               (${NO_HOURS}, ${TENANT}, ${PLACE_CATEGORY}, 'hours-none', 'সময় জানা নেই', 'published', ${at(92.4502)}, 'agent_survey', null)`;
      for (const d of ALL_WEEK) {
        await tx`insert into place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
                 values (${TENANT}, ${ALWAYS}, ${d.day}, '00:00', '00:00', true)`;
      }
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location) values
          (${STORE_OPEN}, ${TENANT}, ${M_OWNER}, 'hours-open', 'খোলা দোকান', 'active', ${at(92.4503)}),
          (${STORE_UNKNOWN}, ${TENANT}, ${M_OWNER}, 'hours-unknown', 'অজানা দোকান', 'active', ${at(92.4504)})`;
      for (let i = 0; i < 3; i++) {
        await tx`
          insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
                             published_at, bumped_at, location, geo_area_id, price_type_code, fields)
          values (${TENANT}, ${M_MEMBER}, ${POST_CATEGORY}, ${SCHEMA}, ${`hours post ${i}`}, 'live',
                  now() - interval '1 hour', now() - interval '1 hour', ${at(92.45 + i / 10000)}, ${AREA},
                  'fixed', '{"price": "100.00"}'::jsonb)`;
      }
    });

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
    const signer = moduleRef.get(TokenService);
    tokens.owner = await signer.signAccessToken({
      userId: OWNER,
      tenantId: TENANT,
      memberId: M_OWNER,
      role: 'member',
    });
    tokens.agent = await signer.signAccessToken({
      userId: AGENT,
      tenantId: TENANT,
      memberId: M_AGENT,
      role: 'agent',
    });
    tokens.member = await signer.signAccessToken({
      userId: MEMBER,
      tenantId: TENANT,
      memberId: M_MEMBER,
      role: 'member',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    as?: keyof typeof tokens,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const placeState = async (id: string) =>
    (await call('GET', `/places/${id}`)).json<{ openState: OpenState }>().openState;

  it('an entity with no hours is unknown, never closed; an always-open one is open', async () => {
    expect(await placeState(NO_HOURS)).toEqual({ state: 'unknown', changesAt: null });
    expect((await placeState(ALWAYS)).state).toBe('open');
  });

  it('a holiday (special day) closes the place for that date, only for its editors to set', async () => {
    const today = localToday();
    const holiday = { days: [{ date: today, closed: true, note: 'ঈদের ছুটি' }] };
    expect(
      (await call('PUT', `/places/${ALWAYS}/special-days`, 'member', holiday)).statusCode,
    ).toBe(403);

    const saved = await call('PUT', `/places/${ALWAYS}/special-days`, 'owner', holiday);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual([{ date: today, closed: true, ranges: [], note: 'ঈদের ছুটি' }]);
    const detail = (await call('GET', `/places/${ALWAYS}`)).json<{
      openState: OpenState;
      specialDays: { date: string }[];
    }>();
    expect(detail.openState.state).toBe('closed');
    // It opens again at the next local midnight.
    expect(detail.openState.changesAt).not.toBeNull();
    expect(detail.specialDays.map((d) => d.date)).toEqual([today]);

    expect(
      (
        await call('PUT', `/places/${ALWAYS}/special-days`, 'owner', {
          days: [{ date: '2020-01-01', closed: true }],
        })
      ).json(),
    ).toMatchObject({ error: 'HOURS_SPECIAL_DAYS_INVALID', details: { reason: 'past' } });

    await call('PUT', `/places/${ALWAYS}/special-days`, 'owner', { days: [] });
    expect((await placeState(ALWAYS)).state).toBe('open');
  });

  it('"closed today" is the owner\'s toggle, until the next local midnight', async () => {
    expect(
      (await call('POST', `/places/${ALWAYS}/closed-today`, 'agent', { closed: true })).statusCode,
    ).toBe(403);
    const closed = await call('POST', `/places/${ALWAYS}/closed-today`, 'owner', { closed: true });
    expect(closed.statusCode).toBe(200);
    const body = closed.json<{ closedUntil: string; openState: OpenState }>();
    expect(body.openState.state).toBe('closed');
    // Midnight in Dhaka is 18:00 UTC.
    expect(body.closedUntil).toMatch(/T18:00:00\.000Z$/);
    expect(body.openState.changesAt).toBe(body.closedUntil);

    const reopened = await call('POST', `/places/${ALWAYS}/closed-today`, 'owner', {
      closed: false,
    });
    expect(reopened.json()).toMatchObject({ closedUntil: null, openState: { state: 'open' } });
  });

  it("a store's week is its managers' to set, and anyone can read it", async () => {
    expect(
      (await call('PUT', `/stores/${STORE_OPEN}/hours`, 'member', { weekly: ALL_WEEK })).statusCode,
    ).toBe(403);
    const tooMany = [1, 2, 3, 4, 5].map((i) => ({ day: 1, opens: `0${i}:00`, closes: `0${i}:30` }));
    expect(
      (await call('PUT', `/stores/${STORE_OPEN}/hours`, 'owner', { weekly: tooMany })).json(),
    ).toMatchObject({
      error: 'HOURS_TOO_MANY_RANGES',
    });
    const saved = await call('PUT', `/stores/${STORE_OPEN}/hours`, 'owner', { weekly: ALL_WEEK });
    expect(saved.statusCode).toBe(200);
    const view = (await call('GET', `/stores/${STORE_OPEN}/hours`)).json<{
      weekly: unknown[];
      usesPlaceHours: boolean;
      openState: OpenState;
    }>();
    expect(view.weekly).toHaveLength(7);
    expect(view).toMatchObject({ usesPlaceHours: false, openState: { state: 'open' } });
    expect(
      (await call('GET', `/stores/${STORE_UNKNOWN}/hours`)).json<{ openState: OpenState }>()
        .openState.state,
    ).toBe('unknown');
  });

  it('open_now on the feed keeps only open store cards; every card says its state', async () => {
    const feed = async (openNow: boolean) =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/feed',
          query: {
            lat: String(VIEWER.lat),
            lng: String(VIEWER.lng),
            scope: 'nearby',
            radius_km: '5',
            ...(openNow ? { open_now: 'true' } : {}),
          },
          headers: { 'x-tenant-id': TENANT },
        })
      ).json<{ items: { kind: string; id: string; openState?: OpenState }[] }>().items;
    const stores = (items: Awaited<ReturnType<typeof feed>>) =>
      items.filter((i) => i.kind === 'store');

    const all = stores(await feed(false));
    expect(all.find((s) => s.id === STORE_UNKNOWN)?.openState).toEqual({
      state: 'unknown',
      changesAt: null,
    });
    expect(all.find((s) => s.id === STORE_OPEN)?.openState?.state).toBe('open');
    const open = stores(await feed(true));
    expect(open.map((s) => s.id)).toEqual([STORE_OPEN]);
  });

  it('open_now on the map keeps open places and stores, with their state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/map/features?bbox=92.449,21.349,92.452,21.351&zoom=18&layers=places,stores&open_now=true',
      headers: { 'x-tenant-id': TENANT },
    });
    expect(response.statusCode).toBe(200);
    const features = response
      .json<{
        features: {
          properties: { id: string; layer: string; open_now: boolean; open_state: string };
        }[];
      }>()
      .features.map((f) => f.properties);
    const ids = features.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([ALWAYS, STORE_OPEN]));
    expect(ids).not.toContain(NO_HOURS);
    expect(ids).not.toContain(STORE_UNKNOWN);
    expect(
      features.every((f) => f.open_now && ['open', 'closes_soon'].includes(f.open_state)),
    ).toBe(true);
  });
});

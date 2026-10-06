import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { BarikoiProvider } from '../src/locations/geocoding/providers/barikoi.provider';
import { FakeProvider } from '../src/locations/geocoding/providers/fake.provider';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The geo provider layer through the real app, Redis and Postgres (ADR 044),
 * with FakeProvider standing in for Barikoi (no network): what is asked of
 * the provider, what is cached and logged to geo_provider_calls, and what
 * GET /analytics/geo-usage reports from that log.
 */

const FIXTURE = '0191e3a0-6e0e-7000-8000-%';
const PARTNER = '0191e3a0-6e0e-7000-8000-000000000001';
const AREA = '0191e3a0-6e0e-7000-8000-000000000011';
const TENANT = '0191e3a0-6e0e-7000-8000-000000000021';
const ADMIN = '0191e3a0-6e0e-7000-8000-000000000031';
const USER = '0191e3a0-6e0e-7000-8000-000000000032';
const NO_MEMBER = '00000000-0000-7000-8000-000000000000';

interface Usage {
  days: { day: string; requests: number; calls: number; cacheHits: number }[];
  topEndpoints: { endpoint: string; calls: number }[];
  today: { calls: number; budget: number; usedPct: number | null };
  month: { callsSoFar: number; projectedCalls: number };
}

describe('Geo provider layer (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const fake = new FakeProvider();
  Object.assign(fake, { name: 'barikoi' }); // stands in for the configured provider
  const tokens: Record<string, string> = {};
  // A query no other suite (or earlier run) has asked, so the cache starts cold.
  const run = Date.now().toString(36);

  const get = (url: string, as?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: as ? { authorization: `Bearer ${tokens[as]}`, 'x-tenant-id': TENANT } : {},
    });
  const usage = async (): Promise<Usage> =>
    (await get('/analytics/geo-usage', 'platformAdmin')).json<Usage>();

  async function cleanUp(): Promise<void> {
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
      insert into users (id, phone_e164, platform_role_code) values
        (${ADMIN}, '+8801799300001', 'platform_admin'), (${USER}, '+8801799300002', null)`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Geo Partner', 'Geo Partner', '+8801799300099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${AREA}, 3, 'upazila', 'geo-e2e', 'Geo E2E Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'geo-e2e', 'জি', 'G', 'SRID=4326;POINT(90 24)', 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT})`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BarikoiProvider)
      .useValue(fake)
      .compile();
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
    for (const [name, userId] of [
      ['platformAdmin', ADMIN],
      ['user', USER],
    ] as const) {
      tokens[name] = await signer.signAccessToken({
        userId,
        tenantId: TENANT,
        memberId: NO_MEMBER,
        role: 'member',
      });
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    try {
      await cleanUp();
    } finally {
      await admin?.end();
    }
  });

  it('asks the provider once for a query, then serves it from the cache (zero calls), and logs both', async () => {
    const before = await usage();
    const q = `zz-${run} road`;
    fake.calls = [];
    const first = await get(`/geo/autocomplete?q=${encodeURIComponent(q)}`);
    const second = await get(`/geo/autocomplete?q=${encodeURIComponent(q.toUpperCase())}`);
    expect(first.statusCode).toBe(200);
    // The same answer (the query is echoed as typed).
    expect(second.json<{ results: unknown }>().results).toEqual(
      first.json<{ results: unknown }>().results,
    );
    expect(fake.calls).toEqual([{ endpoint: 'autocomplete', q, bangla: false }]);
    expect(first.json<{ results: { source: string }[] }>().results[0]).toMatchObject({
      source: 'barikoi',
      kind: 'address',
    });

    const after = await usage();
    expect(after.today.calls - before.today.calls).toBe(1); // barikoi_cost_autocomplete
    const today = (u: Usage) => u.days.at(-1)!;
    expect(today(after).cacheHits - today(before).cacheHits).toBe(1);
  });

  it('reverse geocoding asks only the fields mapped for the purpose, then the cache answers', async () => {
    fake.calls = [];
    // A random block in Bangladesh: no earlier run has cached its geohash cell.
    const lat = Number((21 + Math.random() * 5).toFixed(5));
    const lng = Number((88.5 + Math.random() * 3.5).toFixed(5));
    const first = await get(`/geo/reverse?lat=${lat}&lng=${lng}&purpose=store_setup`);
    expect(first.json()).toMatchObject({
      purpose: 'store_setup',
      address: { source: 'barikoi', labelBn: 'বাড়ি ৮, রোড ২, মিরপুর, ঢাকা' },
      degraded: false,
    });
    expect(fake.calls).toEqual([
      { endpoint: 'reverse', lat, lng, fields: ['bangla', 'post_code'] },
    ]);
    // The same block again: the cache answers (nearby pins in one cell: geo.service.spec).
    await get(`/geo/reverse?lat=${lat}&lng=${lng}&purpose=store_setup`);
    expect(fake.calls).toHaveLength(1);

    await get(`/geo/reverse?lat=${lat}&lng=${lng}`); // purpose=area
    expect(fake.calls).toHaveLength(1);
  });

  it('GET /analytics/geo-usage: platform staff only, with a projection and today against the budget', async () => {
    expect((await get('/analytics/geo-usage')).statusCode).toBe(401);
    expect((await get('/analytics/geo-usage', 'user')).statusCode).toBe(403);
    const response = await get('/analytics/geo-usage?days=7', 'platformAdmin');
    expect(response.statusCode).toBe(200);
    const body = response.json<Usage>();
    expect(body.days).toHaveLength(7); // every day of the window, zeros included
    expect(body.today.budget).toBe(1000);
    expect(body.today.calls).toBeGreaterThanOrEqual(3); // 1 autocomplete + 2… (3 for store_setup)
    expect(body.topEndpoints.map((e) => e.endpoint)).toEqual(
      expect.arrayContaining(['autocomplete', 'reverse']),
    );
    expect(body.month.projectedCalls).toBeGreaterThanOrEqual(body.month.callsSoFar);
  });

  it('the map data API never reaches a geo provider: GET /map/features and /map/distance make zero calls', async () => {
    fake.calls = [];
    const before = await usage();
    const box = 'bbox=90.35,23.74,90.42,23.8';
    for (const zoom of [8, 12, 17]) {
      const response = await get(
        `/map/features?${box}&zoom=${zoom}&layers=posts,stores,places,landmarks,info`,
      );
      expect(response.statusCode).toBe(200);
    }
    expect((await get('/map/distance?from=23.7556,90.3747&to=23.7629,90.3787')).statusCode).toBe(
      200,
    );
    expect(fake.calls).toEqual([]);
    const after = await usage();
    expect(after.today.calls).toBe(before.today.calls);
  });

  it('logs never the query, only what was spent', async () => {
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'geo_provider_calls'`;
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [
        'cache_hit',
        'calls_counted',
        'created_at',
        'endpoint',
        'id',
        'latency_ms',
        'provider',
        'status',
        'tenant_id',
        'updated_at',
      ].sort(),
    );
  });
});

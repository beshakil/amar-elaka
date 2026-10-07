import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * GET /analytics/heatmap (ADR 050): tenant admins get cells (never a point),
 * the minimum and the grid it used; a member or a marketer (analytics:read,
 * but not this report) gets 403. heatmap.db-spec.ts covers the counting.
 */

const FIXTURE = '0191e3a0-4ea8-7000-8000-%';
const PARTNER = '0191e3a0-4ea8-7000-8000-000000000001';
const AREA = '0191e3a0-4ea8-7000-8000-000000000011';
const TENANT = '0191e3a0-4ea8-7000-8000-000000000021';
const ADMIN = '0191e3a0-4ea8-7000-8000-000000000031';
const MEMBER = '0191e3a0-4ea8-7000-8000-000000000032';
const MARKETER = '0191e3a0-4ea8-7000-8000-000000000033';
const M_ADMIN = '0191e3a0-4ea8-7000-8000-000000000041';
const M_MEMBER = '0191e3a0-4ea8-7000-8000-000000000042';
const M_MARKETER = '0191e3a0-4ea8-7000-8000-000000000043';

describe('Heatmap (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Record<'admin' | 'member' | 'marketer', string> = {
    admin: '',
    member: '',
    marketer: '',
  };

  async function cleanUp(): Promise<void> {
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values
      (${ADMIN}, '+8801766700001'), (${MEMBER}, '+8801766700002'), (${MARKETER}, '+8801766700003')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Heat E2E', 'Heat E2E', '+8801766700099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'heat-e2e', 'Heat E2E', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'heat-e2e', 'হিট', 'Heat', 'SRID=4326;POINT(92.25 22.55)', 'active')`;
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M_ADMIN}, ${TENANT}, ${ADMIN}, 'tenant_admin'), (${M_MEMBER}, ${TENANT}, ${MEMBER}, 'member'),
      (${M_MARKETER}, ${TENANT}, ${MARKETER}, 'marketer')`;
    // Five people searching in one cell.
    for (let n = 1; n <= 5; n++) {
      await admin`
        insert into search_queries (tenant_id, searcher_hash, q_normalized, filters_hash, result_count, origin)
        values (${TENANT}, ${n.toString(16).padStart(64, '0')}, 'flat', '0123456789abcdef', 0,
                ${`SRID=4326;POINT(${92.2501 + n / 100000} 22.5501)`})`;
    }

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
    tokens.admin = await signer.signAccessToken({
      userId: ADMIN,
      tenantId: TENANT,
      memberId: M_ADMIN,
      role: 'tenant_admin',
    });
    tokens.member = await signer.signAccessToken({
      userId: MEMBER,
      tenantId: TENANT,
      memberId: M_MEMBER,
      role: 'member',
    });
    tokens.marketer = await signer.signAccessToken({
      userId: MARKETER,
      tenantId: TENANT,
      memberId: M_MARKETER,
      role: 'marketer',
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

  const get = (query: string, as: keyof typeof tokens) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/analytics/heatmap?${query}`,
      headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[as]}` },
    });

  it('gives tenant admins the cells, with the grid and minimum it used', async () => {
    const response = await get('type=demand', 'admin');
    expect(response.statusCode).toBe(200);
    const body = response.json<{ cells: { geohash: string; count: number }[] }>();
    expect(body).toMatchObject({
      type: 'demand',
      category: null,
      precision: 6,
      minCellCount: 5,
      windowDays: 30,
    });
    expect(body.cells).toEqual([expect.objectContaining({ count: 5 })]);
    expect(Object.keys(body.cells[0]!).sort()).toEqual(['count', 'geohash', 'lat', 'lng']);
    expect((await get('type=supply', 'admin')).json<{ cells: unknown[] }>().cells).toEqual([]);
  });

  it('is refused to members and marketers, and validates its input', async () => {
    expect((await get('type=demand', 'member')).statusCode).toBe(403);
    expect((await get('type=demand', 'marketer')).statusCode).toBe(403);
    expect((await get('type=popularity', 'admin')).statusCode).toBe(400);
  });
});

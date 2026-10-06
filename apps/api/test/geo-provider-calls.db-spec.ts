import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * geo_provider_calls (0039, ADR 044): the platform's paid-call log. Only the
 * system role (the API's GeoCallLog) writes it; members, tenant admins and
 * the public can neither read the platform's provider costs nor forge a row,
 * whichever tenant the row is attributed to.
 */

const FIXTURE = '0191e3a0-6e0c-7000-8000-%';
const PARTNER = '0191e3a0-6e0c-7000-8000-000000000001';
const AREA = '0191e3a0-6e0c-7000-8000-000000000011';
const TENANT = '0191e3a0-6e0c-7000-8000-000000000021';
const USER = '0191e3a0-6e0c-7000-8000-000000000031';
const MEMBER = '0191e3a0-6e0c-7000-8000-000000000041';

type Context = Record<string, string>;
const AS_SYSTEM: Context = { role: 'system' };
const AS_PLATFORM: Context = { role: 'platform_admin', is_platform_admin: 'true' };
const AS_ANONYMOUS: Context = { role: 'anonymous' };
const AS_TENANT_ADMIN: Context = {
  tenant_id: TENANT,
  user_id: USER,
  member_id: MEMBER,
  role: 'tenant_admin',
};

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

describe('geo_provider_calls (0039)', () => {
  let admin: Sql;
  let app: Sql;

  const insert = (context: Context, outcome = 'ok') =>
    as(
      app,
      context,
      (tx) => tx`
        insert into geo_provider_calls
          (provider, endpoint, calls_counted, cache_hit, latency_ms, status, tenant_id)
        values ('barikoi', 'reverse', ${outcome === 'cache_hit' ? 0 : 2}, ${outcome === 'cache_hit'},
                180, ${outcome}, ${TENANT})`,
    );
  const count = (context: Context) =>
    as(
      app,
      context,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from geo_provider_calls where tenant_id = ${TENANT}`,
    ).then((rows) => rows[0]!.n);

  async function cleanUp(): Promise<void> {
    await admin`delete from geo_provider_calls where tenant_id::text like ${FIXTURE}`;
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
    await admin`insert into users (id, phone_e164) values (${USER}, '+8801799200001')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Geo Log Partner', 'Geo Log Partner', '+8801799200099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${AREA}, 3, 'upazila', 'geo-log', 'Geo Log Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'geo-log', 'জি', 'G', 'SRID=4326;POINT(90 24)', 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code)
      values (${MEMBER}, ${TENANT}, ${USER}, 'tenant_admin')`;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  it('is written by the system role: calls, cache hits and refusals', async () => {
    await insert(AS_SYSTEM);
    await insert(AS_SYSTEM, 'cache_hit');
    await insert(AS_SYSTEM, 'over_budget');
    expect(await count(AS_SYSTEM)).toBe(3);
  });

  it.each([
    ['a tenant admin of the attributed tenant', AS_TENANT_ADMIN],
    ['the public', AS_ANONYMOUS],
  ])('can be neither written nor read by %s', async (_who, context) => {
    await expect(insert(context)).rejects.toThrow(/row-level security/);
    expect(await count(context)).toBe(0);
  });

  it('is read by the platform', async () => {
    expect(await count(AS_PLATFORM)).toBeGreaterThanOrEqual(2);
  });

  it('refuses unknown endpoints and statuses, negative counts, and a billed cache hit', async () => {
    const bad = (endpoint: string, status: string, calls: number, cacheHit = false) =>
      as(
        app,
        AS_SYSTEM,
        (tx) => tx`
          insert into geo_provider_calls (provider, endpoint, calls_counted, cache_hit, status)
          values ('barikoi', ${endpoint}, ${calls}, ${cacheHit}, ${status})`,
      );
    await expect(bad('tiles', 'ok', 4)).rejects.toThrow(/geo_provider_calls_endpoint_fk/);
    await expect(bad('reverse', 'teapot', 1)).rejects.toThrow(/geo_provider_calls_status_fk/);
    await expect(bad('reverse', 'ok', -1)).rejects.toThrow(/geo_provider_calls_calls_counted_ck/);
    await expect(bad('reverse', 'cache_hit', 2, true)).rejects.toThrow(
      /geo_provider_calls_cache_hit_ck/,
    );
  });

  it('is purged by the system role only', async () => {
    const purge = (context: Context) =>
      as(
        app,
        context,
        (tx) => tx`delete from geo_provider_calls where tenant_id = ${TENANT} returning id`,
      );
    expect(await purge(AS_TENANT_ADMIN)).toHaveLength(0); // RLS: sees and deletes nothing
    expect((await purge(AS_SYSTEM)).length).toBeGreaterThanOrEqual(3);
    expect(await count(AS_SYSTEM)).toBe(0);
  });
});

import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0028 against real Postgres: job_runs RLS (platform staff read,
 * only the system writes, one running run per job), and the RESTRICTIVE
 * delete policy that lets posts be hard-deleted only as a stale, unheld draft
 * by the system.
 */

const FIXTURE = '0191e3a0-71fd-7000-8000-%';
const PARTNER = '0191e3a0-71fd-7000-8000-000000000001';
const AREA = '0191e3a0-71fd-7000-8000-000000000011';
const TENANT = '0191e3a0-71fd-7000-8000-000000000021';
const AUTHOR = '0191e3a0-71fd-7000-8000-000000000031';
const HELD = '0191e3a0-71fd-7000-8000-000000000032';
const ADMIN = '0191e3a0-71fd-7000-8000-000000000033';
const M_AUTHOR = '0191e3a0-71fd-7000-8000-000000000041';
const M_HELD = '0191e3a0-71fd-7000-8000-000000000042';
const M_STAFF = '0191e3a0-71fd-7000-8000-000000000043';
const CATEGORY = '0191e3a0-71fd-7000-8000-000000000051';
const SCHEMA = '0191e3a0-71fd-7000-8000-000000000061';
const HOLD = '0191e3a0-71fd-7000-8000-000000000071';
const DRAFT = '0191e3a0-71fd-7000-8000-000000000101';
const LIVE = '0191e3a0-71fd-7000-8000-000000000102';
const HELD_DRAFT = '0191e3a0-71fd-7000-8000-000000000103';

type Context = Record<string, string>;
// As TenantDb sets them: system and platform_admin also get app.is_platform_admin.
const system: Context = { role: 'system', is_platform_admin: 'true' };
const platformAdmin: Context = {
  role: 'platform_admin',
  user_id: ADMIN,
  is_platform_admin: 'true',
};
const author: Context = { tenant_id: TENANT, user_id: AUTHOR, member_id: M_AUTHOR, role: 'member' };
const tenantAdmin: Context = {
  tenant_id: TENANT,
  user_id: ADMIN,
  member_id: M_STAFF,
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

describe('Lifecycle jobs schema (0028)', () => {
  let admin: Sql;
  let app: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from job_runs where job_code = 'purge-deleted-media' and queue_job_id like 'lifecycle-db-%'`;
    await admin`delete from legal_holds where id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(2, resolveTestAppDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164, platform_role_code) values
        (${AUTHOR}, '+8801799100001', null), (${HELD}, '+8801799100002', null),
        (${ADMIN}, '+8801799100003', 'platform_admin')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Lifecycle DB Partner', 'Lifecycle DB Partner', '+8801799100099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${AREA}, 3, 'upazila', 'lifecycle-db', 'Lifecycle DB', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'lifecycle-db', 'এ', 'A', st_point(88.6, 24.2)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_AUTHOR}, ${TENANT}, ${AUTHOR}, 'member'), (${M_HELD}, ${TENANT}, ${HELD}, 'member'),
        (${M_STAFF}, ${TENANT}, ${ADMIN}, 'tenant_admin')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'lifecycle-db', 'বিভাগ', 'Category')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code, published_at) values
        (${DRAFT}, ${TENANT}, ${M_AUTHOR}, ${CATEGORY}, ${SCHEMA}, 'draft', 'draft', null),
        (${LIVE}, ${TENANT}, ${M_AUTHOR}, ${CATEGORY}, ${SCHEMA}, 'live', 'live', now()),
        (${HELD_DRAFT}, ${TENANT}, ${M_HELD}, ${CATEGORY}, ${SCHEMA}, 'held draft', 'draft', null)`;
    await admin`
      insert into legal_holds (id, subject_type_code, subject_id, reason, placed_by_user_id)
      values (${HOLD}, 'user', ${HELD}, 'fixture', ${ADMIN})`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('job_runs', () => {
    const insertRun = (tx: TransactionSql, queueJobId: string) => tx`
      insert into job_runs (job_code, trigger_code, queue_job_id)
      values ('purge-deleted-media', 'schedule', ${queueJobId}) returning id`;

    it('only the system writes a run, and one job runs once at a time', async () => {
      const [run] = await as(app, system, (tx) => insertRun(tx, 'lifecycle-db-1'));
      expect(run).toBeDefined();
      await expect(as(app, system, (tx) => insertRun(tx, 'lifecycle-db-2'))).rejects.toMatchObject({
        code: '23505',
      });
      for (const context of [platformAdmin, tenantAdmin, author]) {
        await expect(
          as(app, context, (tx) => insertRun(tx, 'lifecycle-db-3')),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('platform staff read the runs; tenant staff and members see nothing', async () => {
      const read = (context: Context) =>
        as(
          app,
          context,
          (tx) => tx`select 1 from job_runs where queue_job_id like 'lifecycle-db-%'`,
        );
      expect(await read(platformAdmin)).toHaveLength(1);
      expect(await read(tenantAdmin)).toHaveLength(0);
      expect(await read(author)).toHaveLength(0);
    });

    it('platform staff cannot rewrite a run', async () => {
      const updated = await as(
        app,
        platformAdmin,
        (tx) => tx`update job_runs set rows_affected = 99 where queue_job_id like 'lifecycle-db-%'`,
      );
      expect(updated.count).toBe(0);
    });
  });

  describe('posts hard delete', () => {
    const remove = (context: Context, id: string) =>
      as(app, context, (tx) => tx`delete from posts where id = ${id}`);

    it('the author, tenant staff and platform admins cannot hard-delete any post', async () => {
      for (const context of [author, tenantAdmin, platformAdmin]) {
        expect((await remove(context, DRAFT)).count).toBe(0);
        expect((await remove(context, LIVE)).count).toBe(0);
      }
    });

    it('the system cannot hard-delete a published post, nor a draft under a legal hold', async () => {
      expect((await remove(system, LIVE)).count).toBe(0);
      expect((await remove(system, HELD_DRAFT)).count).toBe(0);
    });

    it('the system can hard-delete an unheld draft', async () => {
      expect((await remove(system, DRAFT)).count).toBe(1);
    });
  });
});

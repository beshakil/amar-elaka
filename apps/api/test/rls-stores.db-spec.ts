import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the stores & sellers domain (0006_stores.sql):
 * seller_profiles, stores, store_members, store_follows — plus
 * can_manage_store() and the recursion-avoidance trade-off documented in
 * the migration (an accepted non-manager store_members row sees only its
 * own row, not the whole roster).
 */

const PARTNER = '0191e3a0-4444-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-4444-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-4444-7000-8000-000000000012';
const TENANT_A = '0191e3a0-4444-7000-8000-000000000021';
const TENANT_B = '0191e3a0-4444-7000-8000-000000000022';
const USER_OWNER = '0191e3a0-4444-7000-8000-000000000031';
const USER_MANAGER = '0191e3a0-4444-7000-8000-000000000032';
const USER_STRANGER = '0191e3a0-4444-7000-8000-000000000033';
const USER_B = '0191e3a0-4444-7000-8000-000000000034';
const MEMBER_OWNER = '0191e3a0-4444-7000-8000-000000000041';
const MEMBER_MANAGER = '0191e3a0-4444-7000-8000-000000000042';
const MEMBER_STRANGER = '0191e3a0-4444-7000-8000-000000000043';
const MEMBER_B = '0191e3a0-4444-7000-8000-000000000044';
const STORE_ACTIVE = '0191e3a0-4444-7000-8000-000000000051';
const STORE_PENDING = '0191e3a0-4444-7000-8000-000000000052';
const STORE_MEMBER_MANAGER = '0191e3a0-4444-7000-8000-000000000061';
const STORE_FOLLOW = '0191e3a0-4444-7000-8000-000000000071';
const FIXTURE_PREFIX = '0191e3a0-4444-7000-8000-%';

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;

async function withContext<T>(
  sql: Sql,
  context: Context,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

const AS_OWNER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_OWNER,
  member_id: MEMBER_OWNER,
  role: 'member',
};
const AS_MANAGER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_MANAGER,
  member_id: MEMBER_MANAGER,
  role: 'member',
};
const AS_STRANGER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_STRANGER,
  member_id: MEMBER_STRANGER,
  role: 'member',
};
const AS_TENANT_B: Context = {
  tenant_id: TENANT_B,
  user_id: USER_B,
  member_id: MEMBER_B,
  role: 'member',
};

async function expectNoRowsAffected(promise: Promise<{ count: number }>): Promise<void> {
  const result = await promise;
  expect(result.count).toBe(0);
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  expect(error.code).toBe('42501');
}

describe('Row level security: stores domain (0006)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_OWNER}, '+8801744000001'),
        (${USER_MANAGER}, '+8801744000002'),
        (${USER_STRANGER}, '+8801744000003'),
        (${USER_B}, '+8801744000004')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Stores Fixture Partner', 'Stores Fixture Partner', '+8801744000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-stores-a', 'RLS Stores Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-stores-b', 'RLS Stores Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-stores-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-stores-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_OWNER}, ${TENANT_A}, ${USER_OWNER}, 'member'),
        (${MEMBER_MANAGER}, ${TENANT_A}, ${USER_MANAGER}, 'member'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;

    await admin`
      insert into seller_profiles (tenant_id, member_id) values (${TENANT_A}, ${MEMBER_OWNER})`;

    // stores_protect_status fires on INSERT regardless of role — even for
    // this superuser connection — and only lets an explicit status through
    // for app_is_staff()/app_is_system(). Identify this seed as `system`,
    // exactly as a real import/seed script would have to.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code) values
          (${STORE_ACTIVE}, ${TENANT_A}, ${MEMBER_OWNER}, 'rls-stores-active', 'সক্রিয়', 'active'),
          (${STORE_PENDING}, ${TENANT_A}, ${MEMBER_OWNER}, 'rls-stores-pending', 'পেন্ডিং', 'pending_review')`;
    });

    await admin`
      insert into store_members (id, tenant_id, store_id, member_id, role_code, accepted_at) values
        (${STORE_MEMBER_MANAGER}, ${TENANT_A}, ${STORE_ACTIVE}, ${MEMBER_MANAGER}, 'manager', now())`;

    await admin`
      insert into store_follows (id, tenant_id, user_id, store_id) values
        (${STORE_FOLLOW}, ${TENANT_A}, ${USER_STRANGER}, ${STORE_ACTIVE})`;
  });

  afterAll(async () => {
    try {
      await admin`delete from store_follows where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from store_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from stores where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from seller_profiles where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('seller_profiles (§5.1)', () => {
    it('is publicly readable to any member (all fields are public reputation data)', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`select id from seller_profiles where tenant_id = ${TENANT_A} and member_id = ${MEMBER_OWNER}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('lets the owner update business_name but not the rating cache', async () => {
      const result = await withContext(
        app,
        AS_OWNER,
        (tx) =>
          tx`update seller_profiles set business_name = 'My Shop', rating_count = 999
             where tenant_id = ${TENANT_A} and member_id = ${MEMBER_OWNER}`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ business_name: string; rating_count: number }[]>`
        select business_name, rating_count from seller_profiles
        where tenant_id = ${TENANT_A} and member_id = ${MEMBER_OWNER}`;
      expect(row).toMatchObject({ business_name: 'My Shop', rating_count: 0 });
    });

    it('does not let another member update it', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update seller_profiles set business_name = 'Hijacked'
               where tenant_id = ${TENANT_A} and member_id = ${MEMBER_OWNER}`,
        ),
      );
    });
  });

  describe('stores (§5.2)', () => {
    it('shows active stores to any member', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from stores where id = ${STORE_ACTIVE}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('hides pending_review stores from an unrelated member', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from stores where id = ${STORE_PENDING}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('shows the pending store to its owner', async () => {
      const rows = await withContext(
        app,
        AS_OWNER,
        (tx) => tx`select id from stores where id = ${STORE_PENDING}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('forces a fresh insert to pending_review regardless of the requested status', async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into stores (tenant_id, owner_member_id, slug, name_bn, status_code)
             values (${TENANT_A}, ${MEMBER_STRANGER}, 'rls-stores-fresh', 'নতুন', 'active')`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ status_code: string }[]>`
        select status_code from stores where tenant_id = ${TENANT_A} and slug = 'rls-stores-fresh'`;
      expect(row?.status_code).toBe('pending_review');
      await admin`delete from stores where tenant_id = ${TENANT_A} and slug = 'rls-stores-fresh'`;
    });

    it('lets the owner and an accepted manager update, but not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_OWNER,
        (tx) => tx`update stores set description = 'updated by owner' where id = ${STORE_ACTIVE}`,
      );
      expect(asOwner.count).toBe(1);

      const asManager = await withContext(
        app,
        AS_MANAGER,
        (tx) => tx`update stores set description = 'updated by manager' where id = ${STORE_ACTIVE}`,
      );
      expect(asManager.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update stores set description = 'hijacked' where id = ${STORE_ACTIVE}`,
        ),
      );
    });

    it('does not let the owner change status_code directly (staff/service only)', async () => {
      const result = await withContext(
        app,
        AS_OWNER,
        (tx) => tx`update stores set status_code = 'suspended' where id = ${STORE_ACTIVE}`,
      );
      expect(result.count).toBe(1); // the row IS updatable by the owner...
      const [row] = await admin<
        { status_code: string }[]
      >`select status_code from stores where id = ${STORE_ACTIVE}`;
      expect(row?.status_code).toBe('active'); // ...but status_code itself didn't move.
    });

    it('is invisible across tenants even when active', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from stores where id = ${STORE_ACTIVE}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('store_members (§5.3)', () => {
    it('lets the owner see the whole roster', async () => {
      const rows = await withContext(
        app,
        AS_OWNER,
        (tx) => tx<{ id: string }[]>`select id from store_members where store_id = ${STORE_ACTIVE}`,
      );
      expect(rows.map((row) => row.id)).toEqual([STORE_MEMBER_MANAGER]);
    });

    it('lets an accepted manager see their own row', async () => {
      const rows = await withContext(
        app,
        AS_MANAGER,
        (tx) => tx`select id from store_members where id = ${STORE_MEMBER_MANAGER}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('hides store_members rows from an unrelated member', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from store_members where store_id = ${STORE_ACTIVE}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('lets the owner insert a new member; rejects an unrelated member', async () => {
      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into store_members (tenant_id, store_id, member_id) values (${TENANT_A}, ${STORE_ACTIVE}, ${MEMBER_STRANGER})`,
        ),
      );

      const result = await withContext(
        app,
        AS_OWNER,
        (tx) =>
          tx`insert into store_members (tenant_id, store_id, member_id) values (${TENANT_A}, ${STORE_ACTIVE}, ${MEMBER_STRANGER})`,
      );
      expect(result.count).toBe(1);
      await admin`delete from store_members where tenant_id = ${TENANT_A} and member_id = ${MEMBER_STRANGER}`;
    });

    it('self-accept moves accepted_at but not role_code', async () => {
      const disposableId = '0191e3a0-4444-7000-8000-000000000062';
      await admin`
        insert into store_members (id, tenant_id, store_id, member_id, role_code)
        values (${disposableId}, ${TENANT_A}, ${STORE_ACTIVE}, ${MEMBER_STRANGER}, 'staff')`;

      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`update store_members set role_code = 'manager', accepted_at = now() where id = ${disposableId}`,
      );
      expect(result.count).toBe(1);

      const [row] = await admin<{ role_code: string; accepted: boolean }[]>`
        select role_code, accepted_at is not null as accepted from store_members where id = ${disposableId}`;
      expect(row).toMatchObject({ role_code: 'staff', accepted: true });
      await admin`delete from store_members where id = ${disposableId}`;
    });
  });

  describe('store_follows (§5.4)', () => {
    it('is visible to its owner in the store’s tenant context', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from store_follows where id = ${STORE_FOLLOW}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('is not visible to the store owner or manager (no roster access, by design)', async () => {
      const asOwner = await withContext(
        app,
        AS_OWNER,
        (tx) => tx`select id from store_follows where id = ${STORE_FOLLOW}`,
      );
      expect(asOwner).toHaveLength(0);

      const asManager = await withContext(
        app,
        AS_MANAGER,
        (tx) => tx`select id from store_follows where id = ${STORE_FOLLOW}`,
      );
      expect(asManager).toHaveLength(0);
    });

    it('rejects an insert claiming another user_id', async () => {
      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into store_follows (tenant_id, user_id, store_id) values (${TENANT_A}, ${USER_OWNER}, ${STORE_ACTIVE})`,
        ),
      );
    });

    it('lets the owner (of the follow, not the store) delete their own follow', async () => {
      const disposableId = '0191e3a0-4444-7000-8000-000000000072';
      await admin`
        insert into store_follows (id, tenant_id, user_id, store_id) values (${disposableId}, ${TENANT_A}, ${USER_MANAGER}, ${STORE_ACTIVE})`;

      const result = await withContext(
        app,
        AS_MANAGER,
        (tx) => tx`delete from store_follows where id = ${disposableId}`,
      );
      expect(result.count).toBe(1);
    });
  });
});

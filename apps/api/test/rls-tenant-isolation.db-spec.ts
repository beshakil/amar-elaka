import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  resolveTestMigratorDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Adversarial, security-focused proof of tenant isolation (ADR 019,
 * infra/migrations/0002_row_level_security.sql). Where test/rls.db-spec.ts is
 * broad (every table, every policy, the schema itself), this suite is narrow
 * and reads as a checklist: one table (`tenant_members`), nine numbered
 * guarantees, each demonstrated by attacking it directly.
 *
 * `app` connects as `ae_app` — exactly what the API connects as, so a
 * passing test here means the real deployment is safe, not just the schema.
 * `owner` connects as `ae_migrator`, used only for guarantee 6: it owns the
 * table and could otherwise DELETE anything, which is what makes it the
 * right role to prove RLS — not a missing grant — is what blocks the delete.
 * `admin` is the superuser, used only for setup/teardown and to prove data
 * genuinely exists when a policy hides it.
 *
 * Run in isolation with `pnpm --filter api test:rls`.
 */

const PARTNER = '0191e3a0-2222-7000-8000-0000000000d9';
const GEO_AREA_A = '0191e3a0-2222-7000-8000-0000000000e1';
const GEO_AREA_B = '0191e3a0-2222-7000-8000-0000000000e2';
const TENANT_A = '0191e3a0-2222-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-2222-7000-8000-00000000000b';
const USER_A = '0191e3a0-2222-7000-8000-0000000000a1';
const USER_B = '0191e3a0-2222-7000-8000-0000000000b1';
const MEMBER_A = '0191e3a0-2222-7000-8000-0000000000a2';
const MEMBER_B = '0191e3a0-2222-7000-8000-0000000000b2';
// Only for the "owner can delete within its own tenant" control in
// guarantee 6 — a fresh user so the insert doesn't collide with A's existing
// (user_id, tenant_id) membership.
const USER_DISPOSABLE = '0191e3a0-2222-7000-8000-0000000000d0';
const FIXTURE_PREFIX = '0191e3a0-2222-7000-8000-%';

interface Member {
  id: string;
  tenant_id: string;
  role_code: string;
}

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;

/**
 * What TenantDb does in production: transaction-local settings (SET LOCAL,
 * via the parameterised set_config), then the request's work, then
 * COMMIT/ROLLBACK. Every test below goes through this — never a bare query —
 * so a pass proves the real request path, not a shortcut around it.
 */
async function asRequest<T>(
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

const AS_A: Context = { tenant_id: TENANT_A, user_id: USER_A, role: 'member' };
const AS_B: Context = { tenant_id: TENANT_B, user_id: USER_B, role: 'member' };
const AS_PLATFORM_ADMIN: Context = { is_platform_admin: 'true', role: 'platform_admin' };

/** Asserts the statement was rejected by a policy or grant, not merely empty. */
async function expectRejected(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  // 42501 insufficient_privilege covers both "violates row-level security
  // policy" (WITH CHECK failed) and "permission denied for table" (no grant).
  expect(error.code).toBe('42501');
}

describe('Tenant isolation (adversarial)', () => {
  let app: Sql;
  let owner: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    owner = testSqlClient(1, resolveTestMigratorDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    // Superuser: bypasses RLS entirely, which is exactly what fixture setup
    // needs and exactly why the API is never allowed to connect as one.
    await admin`delete from tenant_members where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_A}, '+8801911000011'),
        (${USER_B}, '+8801911000012'),
        (${USER_DISPOSABLE}, '+8801911000013')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Fixture Partner Ltd.', 'Fixture Partner', '+8801911000019')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-adv-fixture-a', 'RLS Adversarial Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-adv-fixture-b', 'RLS Adversarial Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-adv-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-adv-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;
  });

  afterAll(async () => {
    try {
      await admin`delete from tenant_members where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), owner.end(), admin.end()]);
    }
  });

  it('sanity: both fixture rows genuinely exist (RLS hides them, data loss does not)', async () => {
    const rows = await admin<
      Member[]
    >`select id, tenant_id, role_code from tenant_members where id::text like ${FIXTURE_PREFIX}`;
    expect(rows.map((row) => row.id).sort()).toEqual([MEMBER_A, MEMBER_B].sort());
  });

  describe('1. app.tenant_id = A returns only A’s rows', () => {
    it('SELECT', async () => {
      const rows = await asRequest(app, AS_A, (tx) => tx<Member[]>`select * from tenant_members`);
      expect(rows.map((row) => row.id)).toEqual([MEMBER_A]);
      expect(rows.every((row) => row.tenant_id === TENANT_A)).toBe(true);
    });
  });

  describe('2. app.tenant_id = B returns only B’s rows', () => {
    it('SELECT', async () => {
      const rows = await asRequest(app, AS_B, (tx) => tx<Member[]>`select * from tenant_members`);
      expect(rows.map((row) => row.id)).toEqual([MEMBER_B]);
      expect(rows.every((row) => row.tenant_id === TENANT_B)).toBe(true);
    });
  });

  describe('3. app.tenant_id UNSET returns ZERO rows, not all rows', () => {
    it('SELECT with no context at all', async () => {
      const rows = await asRequest(app, {}, (tx) => tx<Member[]>`select * from tenant_members`);
      expect(rows).toHaveLength(0);
    });

    it('is "hidden", not "empty": the same two rows are visible with the right context', async () => {
      const [asA, asB, asAdmin] = await Promise.all([
        asRequest(app, AS_A, (tx) => tx<Member[]>`select id from tenant_members`),
        asRequest(app, AS_B, (tx) => tx<Member[]>`select id from tenant_members`),
        admin<
          Member[]
        >`select id from tenant_members where tenant_id in (${TENANT_A}, ${TENANT_B})`,
      ]);
      expect(asA).toHaveLength(1);
      expect(asB).toHaveLength(1);
      expect(asAdmin).toHaveLength(2); // both rows are still there
    });

    it('empty string and a malformed tenant id behave exactly like unset', async () => {
      for (const tenant_id of ['', 'not-a-uuid', "' OR '1'='1"]) {
        const rows = await asRequest(app, { tenant_id }, (tx) => tx`select * from tenant_members`);
        expect(rows).toHaveLength(0);
      }
    });
  });

  describe('4. tenant A cannot INSERT a row claiming tenant_id = B', () => {
    it('is rejected by WITH CHECK, not silently reassigned to A', async () => {
      await expectRejected(
        asRequest(
          app,
          AS_A,
          (tx) =>
            tx`insert into tenant_members (tenant_id, user_id, role_code) values (${TENANT_B}, ${USER_B}, 'member')`,
        ),
      );
      // Confirm the attempt left no trace under B, e.g. via a coerced tenant_id.
      const stillOnlyOriginal = await admin<
        Member[]
      >`select id from tenant_members where tenant_id = ${TENANT_B}`;
      expect(stillOnlyOriginal.map((row) => row.id)).toEqual([MEMBER_B]);
    });

    it('also cannot smuggle it in via an UPDATE that moves its own row to B', async () => {
      await expectRejected(
        asRequest(
          app,
          AS_A,
          (tx) => tx`update tenant_members set tenant_id = ${TENANT_B} where id = ${MEMBER_A}`,
        ),
      );
      const [row] = await admin<
        Member[]
      >`select tenant_id from tenant_members where id = ${MEMBER_A}`;
      expect(row?.tenant_id).toBe(TENANT_A);
    });
  });

  describe('5. tenant A cannot UPDATE a row belonging to B', () => {
    it('affects zero rows instead of erroring, and B’s row is untouched', async () => {
      const result = await asRequest(
        app,
        AS_A,
        (tx) => tx`update tenant_members set role_code = 'moderator' where id = ${MEMBER_B}`,
      );
      expect(result.count).toBe(0);

      const [row] = await admin<
        Member[]
      >`select role_code from tenant_members where id = ${MEMBER_B}`;
      expect(row?.role_code).toBe('member');
    });

    it('is blocked even with no WHERE clause at all (a table-wide UPDATE)', async () => {
      const result = await asRequest(
        app,
        AS_A,
        (tx) => tx`update tenant_members set role_code = 'moderator'`,
      );
      // Only A's own row is visible to the statement, so only it could change.
      expect(result.count).toBe(1);
      const [bRow] = await admin<
        Member[]
      >`select role_code from tenant_members where id = ${MEMBER_B}`;
      expect(bRow?.role_code).toBe('member');

      // Revert, so later tests see the original fixture state.
      await admin`update tenant_members set role_code = 'member' where id = ${MEMBER_A}`;
    });
  });

  describe('6. tenant A cannot DELETE a row belonging to B', () => {
    // Run as ae_migrator, the table OWNER, which normally has implicit DELETE
    // on everything it owns. ae_app doesn't even have a DELETE grant on this
    // table, so testing with ae_app would only prove the grant is missing.
    // Using the owner isolates the variable: if the delete is still blocked
    // here, it is RLS (FORCE ROW LEVEL SECURITY), not a privilege gap, doing
    // the work — directly answering "how do we know RLS did this?".
    it('the owner deletes nothing when targeting B under tenant A’s context', async () => {
      const result = await asRequest(
        owner,
        { tenant_id: TENANT_A },
        (tx) => tx`delete from tenant_members where id = ${MEMBER_B}`,
      );
      expect(result.count).toBe(0);

      const stillThere = await admin<
        Member[]
      >`select id from tenant_members where id = ${MEMBER_B}`;
      expect(stillThere).toHaveLength(1);
    });

    it('control: the same owner CAN delete a row when the tenant matches', async () => {
      const disposableId = '0191e3a0-2222-7000-8000-0000000000d1';
      await admin`
        insert into tenant_members (id, tenant_id, user_id, role_code)
        values (${disposableId}, ${TENANT_A}, ${USER_DISPOSABLE}, 'agent')`;

      const result = await asRequest(
        owner,
        { tenant_id: TENANT_A },
        (tx) => tx`delete from tenant_members where id = ${disposableId}`,
      );
      expect(result.count).toBe(1);

      const gone = await admin<Member[]>`select id from tenant_members where id = ${disposableId}`;
      expect(gone).toHaveLength(0);
    });

    it('ae_app cannot delete at all, in its own tenant or any other (no grant)', async () => {
      await expectRejected(
        asRequest(app, AS_A, (tx) => tx`delete from tenant_members where id = ${MEMBER_A}`),
      );
    });
  });

  describe('7. a query that "forgets" the tenant filter is still isolated', () => {
    it('a naive SELECT * with no WHERE clause returns only A’s rows', async () => {
      // Deliberately the kind of query a developer writes by mistake —
      // no `WHERE tenant_id = $1` anywhere in the SQL text. If this is safe,
      // isolation does not depend on every call site remembering the filter.
      const rows = await asRequest(app, AS_A, (tx) => tx<Member[]>`select * from tenant_members`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant_id).toBe(TENANT_A);
    });

    it('a WHERE clause explicitly asking for B’s tenant_id is still overridden', async () => {
      // The client's own filter can't override the policy: RLS ANDs its
      // predicate onto every query, it never trusts the query to ask nicely.
      const rows = await asRequest(
        app,
        AS_A,
        (tx) => tx<Member[]>`select * from tenant_members where tenant_id = ${TENANT_B}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('COUNT(*) with no filter counts only the visible tenant, not the table', async () => {
      const [row] = await asRequest(
        app,
        AS_B,
        (tx) => tx<{ count: string }[]>`select count(*)::text as count from tenant_members`,
      );
      expect(row?.count).toBe('1');
    });
  });

  describe('8. platform admin bypass sees both tenants', () => {
    it('SELECT returns rows from A and B in one query', async () => {
      const rows = await asRequest(
        app,
        AS_PLATFORM_ADMIN,
        (tx) =>
          tx<
            Member[]
          >`select id, tenant_id from tenant_members where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
    });

    it('is not granted by anything less than the exact flag "true"', async () => {
      for (const value of ['TRUE', '1', 'yes', '']) {
        const rows = await asRequest(
          app,
          { is_platform_admin: value },
          (tx) => tx`select * from tenant_members`,
        );
        expect(rows).toHaveLength(0);
      }
    });
  });

  describe('9. the session setting does not leak across a pooled connection', () => {
    let singleConn: Sql;

    beforeAll(() => {
      // max: 1 is the point — it forces every "request" below onto the exact
      // same physical backend connection, the way a busy pool would under load.
      singleConn = testSqlClient(1, resolveTestAppDatabaseUrl());
    });

    afterAll(async () => {
      await singleConn.end();
    });

    it('request A, then request B: B never sees A’s tenant, even on the same backend', async () => {
      const requestA = await asRequest(singleConn, AS_A, async (tx) => ({
        pid: (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]?.pid,
        rows: await tx<Member[]>`select id from tenant_members`,
      }));
      expect(requestA.rows.map((row) => row.id)).toEqual([MEMBER_A]);

      const requestB = await singleConn.begin(async (tx) => {
        // Read the raw setting BEFORE request B sets anything of its own.
        // If COMMIT failed to clear it, this is where tenant A would leak in.
        const [leaked] = await tx<{ pid: number; tenant_id: string | null }[]>`
          select pg_backend_pid() as pid, current_setting('app.tenant_id', true) as tenant_id`;

        for (const [key, value] of Object.entries(AS_B)) {
          await tx`select set_config(${`app.${key}`}, ${value}, true)`;
        }
        return {
          pid: leaked?.pid,
          tenantIdBeforeContextWasSet: leaked?.tenant_id,
          rows: await tx<Member[]>`select id from tenant_members`,
        };
      });

      // Same backend connection was actually reused (proves this is a real
      // test of pool reuse, not two independent connections by coincidence).
      expect(requestB.pid).toBe(requestA.pid);
      // The thing that must never happen: B inheriting A's tenant context.
      expect(
        requestB.tenantIdBeforeContextWasSet === null ||
          requestB.tenantIdBeforeContextWasSet === '',
      ).toBe(true);
      expect(requestB.rows.map((row) => row.id)).toEqual([MEMBER_B]);
    });

    it('holds in the other order too: request B, then request A', async () => {
      const requestB = await asRequest(
        singleConn,
        AS_B,
        (tx) => tx<Member[]>`select id from tenant_members`,
      );
      expect(requestB.map((row) => row.id)).toEqual([MEMBER_B]);

      const requestA = await singleConn.begin(async (tx) => {
        const [leaked] = await tx<{ tenant_id: string | null }[]>`
          select current_setting('app.tenant_id', true) as tenant_id`;
        for (const [key, value] of Object.entries(AS_A)) {
          await tx`select set_config(${`app.${key}`}, ${value}, true)`;
        }
        return {
          tenantIdBeforeContextWasSet: leaked?.tenant_id,
          rows: await tx<Member[]>`select id from tenant_members`,
        };
      });

      expect(
        requestA.tenantIdBeforeContextWasSet === null ||
          requestA.tenantIdBeforeContextWasSet === '',
      ).toBe(true);
      expect(requestA.rows.map((row) => row.id)).toEqual([MEMBER_A]);
    });

    it('also holds when request A raises an error instead of committing', async () => {
      await expect(
        asRequest(singleConn, AS_A, async (tx) => {
          await tx`select 1`;
          throw new Error('request A crashed mid-transaction');
        }),
      ).rejects.toThrow('request A crashed mid-transaction');

      const [leaked] = await singleConn<{ tenant_id: string | null }[]>`
        select current_setting('app.tenant_id', true) as tenant_id`;
      expect(leaked?.tenant_id === null || leaked?.tenant_id === '').toBe(true);
    });
  });
});

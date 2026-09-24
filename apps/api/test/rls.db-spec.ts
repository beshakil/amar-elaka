import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  resolveTestMigratorDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Proves the isolation model of infra/migrations/0002 (docs/decisions/019).
 *
 * `app` connects as ae_app — what the API uses. `owner` connects as
 * ae_migrator, to prove FORCE ROW LEVEL SECURITY binds the owner too.
 * `admin` is the superuser, used only to seed and to demonstrate why the API
 * must never connect as one.
 */

const PARTNER = '0191e3a0-1111-7000-8000-0000000000d0';
const PARTNER_B = '0191e3a0-1111-7000-8000-0000000000d1';
const GEO_AREA_A = '0191e3a0-1111-7000-8000-0000000000e1';
const GEO_AREA_B = '0191e3a0-1111-7000-8000-0000000000e2';
const GEO_AREA_ARCHIVED = '0191e3a0-1111-7000-8000-0000000000e3';
const CATEGORY = '0191e3a0-1111-7000-8000-0000000000c1';
const CATEGORY_DISABLED_IN_A = '0191e3a0-1111-7000-8000-0000000000c2';
const LOCALITY_ACTIVE = '0191e3a0-1111-7000-8000-00000000001a';
const LOCALITY_INACTIVE = '0191e3a0-1111-7000-8000-00000000001b';
const TENANT_A = '0191e3a0-1111-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-1111-7000-8000-00000000000b';
const TENANT_ARCHIVED = '0191e3a0-1111-7000-8000-00000000000c';
const USER_A = '0191e3a0-1111-7000-8000-0000000000a1';
const USER_B = '0191e3a0-1111-7000-8000-0000000000b1';
const MEMBER_A = '0191e3a0-1111-7000-8000-0000000000a2';
const MEMBER_B = '0191e3a0-1111-7000-8000-0000000000b2';
const BLACKLISTED = '0191e3a0-1111-7000-8000-0000000000f1';
const FIXTURE_PREFIX = '0191e3a0-1111-7000-8000-%';

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;

/** What TenantDb does, in SQL: transaction-local settings, then the work. */
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

const AS_ADMIN: Context = { is_platform_admin: 'true', role: 'platform_admin' };

async function expectDenied(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string; message?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  // 42501 insufficient_privilege: both "violates row-level security policy"
  // and "permission denied for table".
  expect(error.code).toBe('42501');
  return error.message ?? '';
}

/**
 * For UPDATE (unlike INSERT): a policy that doesn't grant access doesn't
 * raise, it just leaves the row invisible to the statement, so it affects
 * zero rows silently. This is the right assertion for "role X cannot modify
 * row Y" — `expectDenied` is for INSERT's WITH CHECK, which does raise.
 */
async function expectNoRowsAffected(promise: Promise<{ count: number }>): Promise<void> {
  const result = await promise;
  expect(result.count).toBe(0);
}

describe('Row level security', () => {
  let app: Sql;
  let owner: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    owner = testSqlClient(1, resolveTestMigratorDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_A}, '+8801711000001'),
        (${USER_B}, '+8801711000002'),
        (${BLACKLISTED}, '+8801711000003')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Fixture Partner Ltd.', 'Fixture Partner', '+8801711000098'),
        (${PARTNER_B}, 'Fixture Partner B Ltd.', 'Fixture Partner B', '+8801711000097')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-fixture-a', 'RLS Fixture Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-fixture-b', 'RLS Fixture Area B', 'fixture'),
        (${GEO_AREA_ARCHIVED}, 3, 'upazila', 'rls-fixture-z', 'RLS Fixture Area Z', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER_B}, ${GEO_AREA_B}, 'rls-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active'),
        (${TENANT_ARCHIVED}, ${PARTNER}, ${GEO_AREA_ARCHIVED}, 'rls-tenant-z', 'জেড', 'Z',
          st_point(90.6, 24.0)::geography, 'archived')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;

    await admin`
      insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;

    await admin`
      insert into blacklist_entries
        (user_id, reason_code, severity_code, summary, recommended_by_user_id, status_code, evidence_refs, reviewed_by_user_id)
      values
        (${BLACKLISTED}, 'advance_payment_scam', 'terminated', 'Took payment, never delivered', ${USER_A},
         'active', '[{"kind":"chat","ref":"x"}]'::jsonb, ${USER_A})`;

    // 0003 fixtures.
    await admin`
      insert into tenant_domains (tenant_id, hostname) values
        (${TENANT_A}, 'rls-tenant-a.example.test'),
        (${TENANT_B}, 'rls-tenant-b.example.test')`;

    await admin`
      insert into tenant_counters (tenant_id, counter_code, last_value) values
        (${TENANT_A}, 'invoice', 1),
        (${TENANT_B}, 'invoice', 1)`;

    await admin`
      insert into tenant_status_changes
        (tenant_id, from_status_code, to_status_code, reason, is_automatic)
      values
        (${TENANT_A}, null, 'active', 'fixture: provisioned', true),
        (${TENANT_B}, null, 'active', 'fixture: provisioned', true)`;

    await admin`
      insert into tenant_billing (tenant_id, amount_due) values
        (${TENANT_A}, 500.00),
        (${TENANT_B}, 0.00)`;

    await admin`
      insert into tenant_transfers (tenant_id, from_partner_id, to_partner_id) values
        (${TENANT_A}, ${PARTNER}, ${PARTNER_B})`;

    // 0004 fixtures.
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'rls-fixture-category', 'বিভাগ', 'Fixture Category'),
        (${CATEGORY_DISABLED_IN_A}, 'marketplace', 'rls-fixture-category-2', 'বিভাগ২', 'Fixture Category 2')`;

    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled) values
        (${TENANT_A}, ${CATEGORY}, true),
        (${TENANT_A}, ${CATEGORY_DISABLED_IN_A}, false),
        (${TENANT_B}, ${CATEGORY}, true)`;

    await admin`
      insert into localities (id, tenant_id, geo_area_id, name_bn, is_active) values
        (${LOCALITY_ACTIVE}, ${TENANT_A}, ${GEO_AREA_A}, 'সক্রিয় এলাকা', true),
        (${LOCALITY_INACTIVE}, ${TENANT_A}, ${GEO_AREA_A}, 'নিষ্ক্রিয় এলাকা', false)`;
  });

  afterAll(async () => {
    try {
      // audit_logs and tenant_status_changes rows are deliberately NOT cleaned
      // up: both have an immutability trigger that rejects DELETE for
      // everyone, including the superuser. That in turn means the tenants
      // (and, transitively, partners) our tenant_status_changes fixture rows
      // point at can never be hard-deleted either (RESTRICT) — same
      // reasoning §0.5 gives for why tenants are never hard-deleted in
      // production. The global reset (test/db/global-setup.ts) is what
      // clears all of it before the next full run.
      await admin`delete from blacklist_entries where user_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from user_profiles where user_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from localities where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_domains where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_counters where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_billing where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_transfers where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
      // tenants (and thus geo_areas) linger permanently once tenant_status_changes
      // references them (see the big comment above); geo_areas cleanup is skipped
      // for the same reason and left to the next full reset.
    } finally {
      // Always close, or Jest hangs on the open pools instead of reporting.
      await Promise.all([app.end(), owner.end(), admin.end()]);
    }
  });

  describe('the default with no context is "see nothing"', () => {
    it.each([
      ['unset', {}],
      ['empty string', { tenant_id: '' }],
      ['not a uuid', { tenant_id: 'not-a-uuid' }],
      ['sql-ish garbage', { tenant_id: "' or true --" }],
      ['a uuid nobody owns', { tenant_id: '0191e3a0-dead-7000-8000-00000000dead' }],
    ])('sees zero tenant_members rows when app.tenant_id is %s', async (_label, context) => {
      const rows = await withContext(app, context, (tx) => tx`select id from tenant_members`);
      expect(rows).toHaveLength(0);
    });

    it('returns NULL from current_tenant_id() instead of raising', async () => {
      const [row] = await withContext(
        app,
        { tenant_id: 'not-a-uuid' },
        (tx) => tx`select current_tenant_id() as tenant, is_platform_admin() as admin`,
      );
      expect(row).toMatchObject({ tenant: null, admin: false });
    });

    it('cannot insert a tenant-scoped row with no context', async () => {
      const message = await expectDenied(
        withContext(
          app,
          {},
          (tx) =>
            tx`insert into tenant_members (tenant_id, user_id, role_code) values (${TENANT_A}, ${USER_A}, 'member')`,
        ),
      );
      expect(message).toContain('row-level security');
    });
  });

  describe('tenant isolation', () => {
    it('shows a tenant only its own members', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) => tx<{ id: string }[]>`select id from tenant_members`,
      );
      expect(rows.map((row) => row.id)).toEqual([MEMBER_A]);
    });

    it('cannot insert a row for another tenant', async () => {
      await expectDenied(
        withContext(
          app,
          { tenant_id: TENANT_A },
          (tx) =>
            tx`insert into tenant_members (tenant_id, user_id, role_code) values (${TENANT_B}, ${USER_B}, 'member')`,
        ),
      );
    });

    it('cannot move its own row to another tenant (WITH CHECK)', async () => {
      await expectDenied(
        withContext(
          app,
          { tenant_id: TENANT_A },
          (tx) => tx`update tenant_members set tenant_id = ${TENANT_B} where id = ${MEMBER_A}`,
        ),
      );
    });

    it('updates nothing when it targets another tenant by id', async () => {
      const result = await withContext(
        app,
        { tenant_id: TENANT_A },
        (tx) => tx`update tenant_members set role_code = 'moderator' where id = ${MEMBER_B}`,
      );
      expect(result.count).toBe(0);
      const [row] = await withContext(
        admin,
        {},
        (tx) =>
          tx<{ role_code: string }[]>`select role_code from tenant_members where id = ${MEMBER_B}`,
      );
      expect(row?.role_code).toBe('member');
    });

    it('has no DELETE privilege at all on membership history', async () => {
      await expectDenied(
        withContext(app, { tenant_id: TENANT_A }, (tx) => tx`delete from tenant_members`),
      );
    });

    it('isolates tenant_settings the same way', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_B },
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from tenant_settings`,
      );
      expect(rows.map((row) => row.tenant_id)).toEqual([TENANT_B]);
    });
  });

  describe('the platform admin bypass', () => {
    it('sees every tenant when app.is_platform_admin is exactly "true"', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx<{ id: string }[]>`select id from tenant_members where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.id).sort()).toEqual([MEMBER_A, MEMBER_B].sort());
    });

    it.each(['TRUE', 'True', '1', 'yes', 't', 'true ', ''])(
      'is not granted by the value %p',
      async (value) => {
        const rows = await withContext(
          app,
          { is_platform_admin: value },
          (tx) => tx`select id from tenant_members`,
        );
        expect(rows).toHaveLength(0);
      },
    );

    it('still needs the flag even for the schema owner (FORCE ROW LEVEL SECURITY)', async () => {
      const withoutFlag = await withContext(owner, {}, (tx) => tx`select id from tenant_members`);
      expect(withoutFlag).toHaveLength(0);

      const withFlag = await withContext(
        owner,
        AS_ADMIN,
        (tx) => tx`select id from tenant_members where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(withFlag).toHaveLength(2);
    });

    it('negative control: a superuser ignores policies entirely, which is why the API is not one', async () => {
      const rows = await withContext(
        admin,
        {},
        (tx) => tx`select id from tenant_members where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('global tables', () => {
    it('lets anyone read enum tables without any context', async () => {
      const [row] = await withContext(
        app,
        {},
        (tx) => tx<{ count: string }[]>`select count(*)::text as count from member_roles`,
      );
      expect(Number(row?.count)).toBeGreaterThan(0);
    });

    it('refuses enum writes without the admin flag', async () => {
      await expectDenied(
        withContext(
          app,
          { tenant_id: TENANT_A },
          (tx) =>
            tx`insert into member_roles (code, label_key, sort_order) values ('sneaky', 'roles.sneaky', 99)`,
        ),
      );
    });

    it('allows enum writes for the platform admin', async () => {
      await withContext(app, AS_ADMIN, async (tx) => {
        await tx`insert into member_roles (code, label_key, sort_order) values ('rls_probe', 'roles.rls_probe', 99)`;
        await tx`delete from member_roles where code = 'rls_probe'`;
      }).catch((error: unknown) => {
        // delete is not granted; the insert is what this test asserts.
        expect((error as { code?: string }).code).toBe('42501');
      });
      const [row] = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select code from member_roles where code = 'rls_probe'`,
      );
      expect(row).toBeUndefined();
    });

    it('shows non-archived tenants to everyone and hides archived ones', async () => {
      const rows = await withContext(
        app,
        {},
        (tx) => tx<{ id: string }[]>`select id from tenants where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.id).sort()).toEqual([TENANT_A, TENANT_B].sort());
    });

    it('shows archived tenants to the platform admin', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from tenants where id = ${TENANT_ARCHIVED}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('lets a user read only their own users row', async () => {
      const rows = await withContext(
        app,
        { user_id: USER_A, tenant_id: TENANT_A },
        (tx) => tx<{ id: string }[]>`select id from users where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.id)).toEqual([USER_A]);
    });

    it('shows no users at all with no user context', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A },
        (tx) => tx`select id from users`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('blacklist', () => {
    // 0010 replaced the temporary "platform only until auth lands" policy
    // (0002) with the real spec RLS (§9.6): tenant staff reading active
    // entries is the whole point of a platform-wide blacklist, so this is
    // no longer "invisible to a tenant" — only to a non-staff member.
    it('active entries are visible to any tenant staff, not to a plain member', async () => {
      const asStaff = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
        (tx) => tx`select id from blacklist_entries where user_id = ${BLACKLISTED}`,
      );
      expect(asStaff).toHaveLength(1);

      const asMember = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) => tx`select id from blacklist_entries where user_id = ${BLACKLISTED}`,
      );
      expect(asMember).toHaveLength(0);
    });

    it('cannot be written by a tenant admin (a tenant may only recommend, later)', async () => {
      await expectDenied(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) => tx`
            insert into blacklist_entries
              (user_id, reason_code, severity_code, summary, recommended_by_user_id)
            values (${USER_B}, 'harassment', 'watch', 'I do not like them', ${USER_A})`,
        ),
      );
    });

    it('is visible to the platform admin', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from blacklist_entries where user_id = ${BLACKLISTED}`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('audit logs', () => {
    it('accepts an append for the current tenant', async () => {
      const result = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) => tx`
          insert into audit_logs (tenant_id, actor_user_id, actor_role, action, entity_table)
          values (${TENANT_A}, ${USER_A}, 'member', 'member.login', 'tenant_members')`,
      );
      expect(result.count).toBe(1);
    });

    it('rejects an append attributed to another tenant', async () => {
      await expectDenied(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A },
          (tx) => tx`
            insert into audit_logs (tenant_id, actor_user_id, actor_role, action, entity_table)
            values (${TENANT_B}, ${USER_A}, 'member', 'member.login', 'tenant_members')`,
        ),
      );
    });

    it('cannot be read back by the tenant that wrote it', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A },
        (tx) => tx`select id from audit_logs`,
      );
      expect(rows).toHaveLength(0);
    });

    it('is readable by the platform admin', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from audit_logs where actor_user_id = ${USER_A}`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('cannot be updated or deleted by anyone through the app role', async () => {
      await expectDenied(
        withContext(app, AS_ADMIN, (tx) => tx`update audit_logs set reason = 'edited'`),
      );
      await expectDenied(withContext(app, AS_ADMIN, (tx) => tx`delete from audit_logs`));
    });

    it('cannot be reached by naming a partition directly', async () => {
      const partitions = await admin<{ relname: string }[]>`
        select relname from pg_class where relispartition and relkind = 'r' order by relname limit 1`;
      const partition = partitions[0]?.relname;
      expect(partition).toBeDefined();
      await expectDenied(
        withContext(app, AS_ADMIN, (tx) => tx.unsafe(`select * from public.${partition}`)),
      );
    });
  });

  describe('partners (§2.1)', () => {
    it('is invisible to a plain member', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) => tx`select id from partners where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('lets a tenant_admin see only the partner operating their own tenant', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
        (tx) => tx<{ id: string }[]>`select id from partners where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.id)).toEqual([PARTNER]);
    });

    it("does not let a tenant_admin see the OTHER tenant's partner", async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
        (tx) => tx`select id from partners where id = ${PARTNER_B}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('is fully visible and writable to the platform admin', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx<{ id: string }[]>`select id from partners where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.id).sort()).toEqual([PARTNER, PARTNER_B].sort());
    });

    it('cannot be written by a tenant_admin', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) => tx`update partners set display_name = 'Hijacked' where id = ${PARTNER}`,
        ),
      );
    });
  });

  describe('tenant_domains (§2.5)', () => {
    it('is readable with no context at all (pre-context routing)', async () => {
      const rows = await withContext(
        app,
        {},
        (tx) =>
          tx<
            { hostname: string }[]
          >`select hostname from tenant_domains where tenant_id = ${TENANT_A}`,
      );
      expect(rows.map((row) => row.hostname)).toEqual(['rls-tenant-a.example.test']);
    });

    it('cannot be written by a tenant admin (platform-admin only)', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) => tx`update tenant_domains set is_primary = true where tenant_id = ${TENANT_A}`,
        ),
      );
    });

    it('can be written by the platform admin', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update tenant_domains set is_primary = true where tenant_id = ${TENANT_A}`,
      );
      expect(result.count).toBe(1);
      await admin`update tenant_domains set is_primary = false where tenant_id = ${TENANT_A}`;
    });
  });

  describe('tenant_counters (§2.6)', () => {
    it('is isolated per tenant', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A },
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from tenant_counters`,
      );
      expect(rows.every((row) => row.tenant_id === TENANT_A)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('is invisible with no context', async () => {
      const rows = await withContext(app, {}, (tx) => tx`select * from tenant_counters`);
      expect(rows).toHaveLength(0);
    });

    it("lets a member increment their own tenant's counter", async () => {
      const result = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) =>
          tx`update tenant_counters set last_value = last_value + 1
             where tenant_id = ${TENANT_A} and counter_code = 'invoice'`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('tenant_status_changes (§2.14)', () => {
    it('is readable by tenant_admin/partner_owner for their own tenant only', async () => {
      const asAdmin = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from tenant_status_changes`,
      );
      expect(asAdmin.every((row) => row.tenant_id === TENANT_A)).toBe(true);
      expect(asAdmin.length).toBeGreaterThan(0);
    });

    it('is invisible to a plain member', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) => tx`select id from tenant_status_changes`,
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot be written through the app role at all (trigger-only, per 0003)', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`insert into tenant_status_changes (tenant_id, to_status_code, reason, is_automatic)
               values (${TENANT_A}, 'suspended', 'manual probe', true)`,
        ),
      );
    });

    it('is immutable: not even the platform admin can UPDATE or DELETE', async () => {
      await expectDenied(
        withContext(app, AS_ADMIN, (tx) => tx`update tenant_status_changes set reason = 'edited'`),
      );
      await expectDenied(withContext(app, AS_ADMIN, (tx) => tx`delete from tenant_status_changes`));
    });
  });

  describe('tenant_billing (§2.15)', () => {
    it('is readable by tenant_admin/partner_owner for their own tenant only', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from tenant_billing`,
      );
      expect(rows.map((row) => row.tenant_id)).toEqual([TENANT_A]);
    });

    it('cannot be updated by a tenant_admin (platform_finance/platform_admin/system only)', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) => tx`update tenant_billing set amount_due = 0 where tenant_id = ${TENANT_A}`,
        ),
      );
    });

    it('can be updated by platform_finance', async () => {
      const result = await withContext(
        app,
        { role: 'platform_finance' },
        (tx) => tx`update tenant_billing set amount_due = 999.00 where tenant_id = ${TENANT_A}`,
      );
      expect(result.count).toBe(1);
      await admin`update tenant_billing set amount_due = 500.00 where tenant_id = ${TENANT_A}`;
    });
  });

  describe('tenant_transfers (§2.13)', () => {
    it('is readable by tenant_admin/partner_owner for their own tenant only', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from tenant_transfers`,
      );
      expect(rows.map((row) => row.tenant_id)).toEqual([TENANT_A]);
    });

    it('is invisible to a tenant_admin of a different tenant', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_B, user_id: USER_B, role: 'tenant_admin' },
        (tx) => tx`select id from tenant_transfers where tenant_id = ${TENANT_A}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot be written by a tenant_admin (platform_admin/platform_finance only)', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) =>
            tx`update tenant_transfers set status_code = 'agreed' where tenant_id = ${TENANT_A}`,
        ),
      );
    });
  });

  describe('platform_settings (§2.16)', () => {
    it('is readable by staff but not by a plain member', async () => {
      const asStaff = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'moderator' },
        (tx) => tx`select key from platform_settings where key = 'grace_past_due_days'`,
      );
      expect(asStaff).toHaveLength(1);

      const asMember = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'member' },
        (tx) => tx`select key from platform_settings where key = 'grace_past_due_days'`,
      );
      expect(asMember).toHaveLength(0);
    });

    it('cannot be written by anyone other than the platform admin', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { role: 'platform_finance' },
          (tx) => tx`update platform_settings set value = '999' where key = 'grace_past_due_days'`,
        ),
      );
    });
  });

  describe('user_profiles (§2.8)', () => {
    it('is publicly readable, including with no context', async () => {
      await admin`
        insert into user_profiles (user_id, display_name) values (${USER_A}, 'Fixture A')
        on conflict (user_id) do nothing`;
      const rows = await withContext(
        app,
        {},
        (tx) =>
          tx<
            { display_name: string }[]
          >`select display_name from user_profiles where user_id = ${USER_A}`,
      );
      expect(rows.map((row) => row.display_name)).toEqual(['Fixture A']);
    });

    it('lets the owner update their own display_name but not their trust band', async () => {
      await withContext(
        app,
        { user_id: USER_A },
        (tx) => tx`update user_profiles set display_name = 'Renamed', trust_band_code = 'top'
                   where user_id = ${USER_A}`,
      );
      const [row] = await admin<{ display_name: string; trust_band_code: string }[]>`
        select display_name, trust_band_code from user_profiles where user_id = ${USER_A}`;
      expect(row).toMatchObject({ display_name: 'Renamed', trust_band_code: 'new' });
    });

    it('cannot be updated by another user', async () => {
      const result = await withContext(
        app,
        { user_id: USER_B },
        (tx) => tx`update user_profiles set display_name = 'Hijacked' where user_id = ${USER_A}`,
      );
      expect(result.count).toBe(0);
    });
  });

  describe('geo_areas (§3.1): G-REFERENCE', () => {
    it('is readable with no context at all', async () => {
      const rows = await withContext(
        app,
        {},
        (tx) =>
          tx<{ id: string }[]>`select id from geo_areas where id::text like ${FIXTURE_PREFIX}`,
      );
      expect(rows.map((row) => row.id).sort()).toEqual(
        [GEO_AREA_A, GEO_AREA_B, GEO_AREA_ARCHIVED].sort(),
      );
    });

    it('cannot be written by a tenant_admin', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) => tx`update geo_areas set name_en = 'Hijacked' where id = ${GEO_AREA_A}`,
        ),
      );
    });

    it('can be written by the platform admin', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update geo_areas set is_active = true where id = ${GEO_AREA_A}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('categories and category_field_schemas (§3.3-3.4): G-REFERENCE', () => {
    it('are both readable with no context at all', async () => {
      const [categoryRows, memberRole] = await Promise.all([
        withContext(app, {}, (tx) => tx`select id from categories where id = ${CATEGORY}`),
        withContext(app, {}, (tx) => tx`select code from member_roles`),
      ]);
      expect(categoryRows).toHaveLength(1);
      expect(memberRole.length).toBeGreaterThan(0); // sanity: context-free reads work at all
    });

    it('categories cannot be written by a tenant_admin', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, user_id: USER_A, role: 'tenant_admin' },
          (tx) => tx`update categories set name_en = 'Hijacked' where id = ${CATEGORY}`,
        ),
      );
    });
  });

  describe('localities (§3.2): T-PUBLIC-READ (active rows); staff+agent write', () => {
    it('shows active rows to a plain member', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, user_id: USER_A, role: 'member' },
        (tx) => tx<{ id: string }[]>`select id from localities where tenant_id = ${TENANT_A}`,
      );
      expect(rows.map((row) => row.id)).toEqual([LOCALITY_ACTIVE]);
    });

    it('hides inactive rows from a plain member but shows them to staff', async () => {
      const asMember = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'member' },
        (tx) => tx`select id from localities where id = ${LOCALITY_INACTIVE}`,
      );
      expect(asMember).toHaveLength(0);

      const asAgent = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'agent' },
        (tx) => tx<{ id: string }[]>`select id from localities where tenant_id = ${TENANT_A}`,
      );
      expect(asAgent.map((row) => row.id).sort()).toEqual(
        [LOCALITY_ACTIVE, LOCALITY_INACTIVE].sort(),
      );
    });

    it('is invisible to a member of a different tenant', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_B, role: 'member' },
        (tx) => tx`select id from localities where id = ${LOCALITY_ACTIVE}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('can be written by an agent (explicitly allowed, unlike the usual staff set)', async () => {
      const result = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'agent' },
        (tx) => tx`update localities set sort_order = 1 where id = ${LOCALITY_ACTIVE}`,
      );
      expect(result.count).toBe(1);
      await admin`update localities set sort_order = 0 where id = ${LOCALITY_ACTIVE}`;
    });

    it('cannot be written by a plain member', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, role: 'member' },
          (tx) => tx`update localities set sort_order = 1 where id = ${LOCALITY_ACTIVE}`,
        ),
      );
    });
  });

  describe('tenant_categories (§3.5): T-PUBLIC-READ (enabled rows); tenant_admin write', () => {
    it('shows enabled rows to a plain member', async () => {
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'member' },
        (tx) =>
          tx<
            { category_id: string }[]
          >`select category_id from tenant_categories where tenant_id = ${TENANT_A}`,
      );
      expect(rows.map((row) => row.category_id)).toEqual([CATEGORY]);
    });

    it('hides disabled rows from a plain member but shows them to tenant_admin', async () => {
      const asMember = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'member' },
        (tx) => tx`select id from tenant_categories where category_id = ${CATEGORY_DISABLED_IN_A}`,
      );
      expect(asMember).toHaveLength(0);

      const asAdmin = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'tenant_admin' },
        (tx) =>
          tx<
            { category_id: string }[]
          >`select category_id from tenant_categories where tenant_id = ${TENANT_A}`,
      );
      expect(asAdmin.map((row) => row.category_id).sort()).toEqual(
        [CATEGORY, CATEGORY_DISABLED_IN_A].sort(),
      );
    });

    it('is invisible to a member of a different tenant even when enabled', async () => {
      // TENANT_B also enables CATEGORY — proves the isolation is on tenant_id,
      // not just is_enabled.
      const rows = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'member' },
        (tx) =>
          tx<
            { tenant_id: string }[]
          >`select tenant_id from tenant_categories where category_id = ${CATEGORY}`,
      );
      expect(rows.map((row) => row.tenant_id)).toEqual([TENANT_A]);
    });

    it('can be written by tenant_admin', async () => {
      const result = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'tenant_admin' },
        (tx) =>
          tx`update tenant_categories set sort_order = 1 where category_id = ${CATEGORY} and tenant_id = ${TENANT_A}`,
      );
      expect(result.count).toBe(1);
      await admin`update tenant_categories set sort_order = 0 where category_id = ${CATEGORY} and tenant_id = ${TENANT_A}`;
    });

    it('cannot be written by a plain member', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          { tenant_id: TENANT_A, role: 'member' },
          (tx) =>
            tx`update tenant_categories set sort_order = 1 where category_id = ${CATEGORY} and tenant_id = ${TENANT_A}`,
        ),
      );
    });
  });

  describe('the schema itself', () => {
    it('gives ae_app no superuser, no bypassrls and no ownership', async () => {
      const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        select rolsuper, rolbypassrls from pg_roles where rolname = 'ae_app'`;
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });

      const [owned] = await admin<{ count: string }[]>`
        select count(*)::text as count
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relowner = 'ae_app'::regrole`;
      expect(owned?.count).toBe('0');
    });

    it('has ae_migrator owning every table, with RLS enabled and forced', async () => {
      const rows = await admin<
        { relname: string; owner: string; enabled: boolean; forced: boolean }[]
      >`
        select c.relname,
               pg_get_userbyid(c.relowner) as owner,
               c.relrowsecurity as enabled,
               c.relforcerowsecurity as forced
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and not exists (
            select 1 from pg_depend d
            where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
          )`;
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.filter((row) => row.owner !== 'ae_migrator' || !row.enabled || !row.forced),
      ).toEqual([]);
    });

    it('does not let ae_app create tables or weaken policies', async () => {
      // DDL takes its lock before checking ownership, so a concurrent
      // transaction could make these wait instead of fail. lock_timeout keeps
      // the assertion about privileges, not about timing.
      const ddl = (statement: string) =>
        expectDenied(
          app.begin(async (tx) => {
            await tx`set local lock_timeout = '5s'`;
            await tx.unsafe(statement);
          }),
        );

      await ddl('create table rls_probe (id uuid)');
      await ddl('alter table tenant_members disable row level security');
      await ddl('drop policy tenant_members_tenant_isolation on tenant_members');
    });
  });
});

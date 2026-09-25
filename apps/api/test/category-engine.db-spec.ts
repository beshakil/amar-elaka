import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0017 (docs/specs/categories.md §6, C1/C2/C3/C7): module-kind
 * home tiles, per-category post expiry with a tenant override, searchable
 * fields, and the place re-verification setting. Constraint tests run as
 * the superuser (constraints and triggers bind everyone); the new
 * category_modules enum table's RLS is tested as ae_app.
 */

const PARTNER = '0191e3a0-5555-7000-8000-000000000001';
const GEO_AREA = '0191e3a0-5555-7000-8000-000000000011';
const TENANT = '0191e3a0-5555-7000-8000-000000000021';
const USER = '0191e3a0-5555-7000-8000-000000000031';
const MEMBER = '0191e3a0-5555-7000-8000-000000000041';
const MARKETPLACE = '0191e3a0-5555-7000-8000-000000000051';
const PLACE_KIND = '0191e3a0-5555-7000-8000-000000000052';
const MODULE_TILE = '0191e3a0-5555-7000-8000-000000000053';
const SCRATCH = '0191e3a0-5555-7000-8000-000000000054';
const FIELD_SCHEMA = '0191e3a0-5555-7000-8000-000000000061';
const FIXTURE_PREFIX = '0191e3a0-5555-7000-8000-%';
const POINT = 'SRID=4326;POINT(90.4 23.8)';

async function expectCheckViolation(promise: Promise<unknown>, pattern?: RegExp): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string; message?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  expect(error.code).toBe('23514');
  if (pattern) expect(error.message).toMatch(pattern);
}

async function asMember<T>(sql: Sql, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${TENANT}, true)`;
    await tx`select set_config('app.user_id', ${USER}, true)`;
    await tx`select set_config('app.member_id', ${MEMBER}, true)`;
    await tx`select set_config('app.role', 'member', true)`;
    return work(tx);
  }) as Promise<T>;
}

describe('Category engine (0017)', () => {
  let admin: Sql;
  let app: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from places where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(2, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`insert into users (id, phone_e164) values (${USER}, '+8801755000001')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Category Engine Partner', 'Category Engine Partner', '+8801755000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA}, 3, 'upazila', 'category-engine-a', 'Category Engine Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'category-engine-tenant', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;

    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_post_expiry_days) values
        (${MARKETPLACE}, 'marketplace', 'category-engine-market', 'বাজার', 'Market', 30)`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${PLACE_KIND}, 'place', 'category-engine-place', 'স্থান', 'Place')`;
    await admin`
      insert into categories (id, kind_code, module_code, slug, name_bn, name_en) values
        (${MODULE_TILE}, 'module', 'emergency', 'category-engine-emergency', 'জরুরি', 'Emergency')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, searchable_fields, status_code, published_at)
      values (${FIELD_SCHEMA}, ${MARKETPLACE}, 1, '{"type":"object"}', '{brand}', 'published', now())`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  describe('module tiles (C2)', () => {
    it('ships the module kind and the three module codes', async () => {
      const kinds = await admin<
        { code: string }[]
      >`select code from category_kinds where code = 'module'`;
      expect(kinds).toHaveLength(1);
      const modules = await admin<
        { code: string }[]
      >`select code from category_modules order by sort_order`;
      expect(modules.map((m) => m.code)).toEqual(['emergency', 'blood', 'bazar']);
    });

    it('requires module_code exactly when the kind is module', async () => {
      await expectCheckViolation(
        admin`insert into categories (id, kind_code, slug, name_bn, name_en)
              values (${SCRATCH}, 'module', 'category-engine-scratch', 'ক', 'X')`,
        /categories_module_code_ck/,
      );
      await expectCheckViolation(
        admin`insert into categories (id, kind_code, module_code, slug, name_bn, name_en)
              values (${SCRATCH}, 'marketplace', 'blood', 'category-engine-scratch', 'ক', 'X')`,
        /categories_module_code_ck/,
      );
    });

    it('allows one live tile per module', async () => {
      const error = await admin`
        insert into categories (id, kind_code, module_code, slug, name_bn, name_en)
        values (${SCRATCH}, 'module', 'emergency', 'category-engine-scratch', 'ক', 'X')`.then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(error?.code).toBe('23505');
    });

    it('gives a module tile no posting price, no expiry and no children', async () => {
      await expectCheckViolation(
        admin`update categories set default_post_cost_credits = 1 where id = ${MODULE_TILE}`,
        /categories_module_shape_ck/,
      );
      await expectCheckViolation(
        admin`update categories set default_post_expiry_days = 7 where id = ${MODULE_TILE}`,
        /categories_expiry_kind_ck/,
      );
      await expectCheckViolation(
        admin`insert into categories (id, parent_id, kind_code, module_code, slug, name_bn, name_en)
              values (${SCRATCH}, ${MODULE_TILE}, 'module', 'bazar', 'category-engine-scratch', 'ক', 'X')`,
        /categories_module_shape_ck/,
      );
    });

    it('rejects a field schema, a post or a place in a module tile', async () => {
      await expectCheckViolation(
        admin`insert into category_field_schemas (category_id, version, json_schema)
              values (${MODULE_TILE}, 1, '{"type":"object"}')`,
        /module tile/,
      );
      await expectCheckViolation(
        admin`insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title)
              values (${TENANT}, ${MEMBER}, ${MODULE_TILE}, ${FIELD_SCHEMA}, 'x')`,
        /module-kind category/,
      );
      await expectCheckViolation(
        admin`insert into places (tenant_id, category_id, slug, name_bn, location, source_code)
              values (${TENANT}, ${MODULE_TILE}, 'category-engine-place', 'ক', ${POINT}, 'user_submitted')`,
        /must be a place-kind category/,
      );
    });

    it('still accepts posts in an ordinary category', async () => {
      const [post] = await admin<{ id: string }[]>`
        insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title)
        values (${TENANT}, ${MEMBER}, ${MARKETPLACE}, ${FIELD_SCHEMA}, 'ok') returning id`;
      expect(post?.id).toBeDefined();
    });

    it('refuses to turn a category with field schemas into a module tile', async () => {
      await expectCheckViolation(
        admin`update categories set kind_code = 'module', module_code = 'blood' where id = ${MARKETPLACE}`,
        /cannot become a module tile/,
      );
    });
  });

  describe('post expiry (C1)', () => {
    it('rejects a non-positive category expiry and any expiry on a place category', async () => {
      await expectCheckViolation(
        admin`update categories set default_post_expiry_days = 0 where id = ${MARKETPLACE}`,
        /categories_default_post_expiry_days_ck/,
      );
      await expectCheckViolation(
        admin`update categories set default_post_expiry_days = 30 where id = ${PLACE_KIND}`,
        /categories_expiry_kind_ck/,
      );
    });

    it('lets a tenant override expiry only for categories that take posts', async () => {
      await admin`
        insert into tenant_categories (tenant_id, category_id, post_expiry_days)
        values (${TENANT}, ${MARKETPLACE}, 45)`;
      await expectCheckViolation(
        admin`insert into tenant_categories (tenant_id, category_id, post_expiry_days)
              values (${TENANT}, ${PLACE_KIND}, 45)`,
        /takes no posts/,
      );
      await expectCheckViolation(
        admin`insert into tenant_categories (tenant_id, category_id, post_cost_credits)
              values (${TENANT}, ${MODULE_TILE}, 1)`,
        /takes no posts/,
      );
      await expectCheckViolation(
        admin`update tenant_categories set post_expiry_days = 0
              where tenant_id = ${TENANT} and category_id = ${MARKETPLACE}`,
        /tenant_categories_post_expiry_days_ck/,
      );
    });

    it('still lets a tenant enable a place or module tile without overrides', async () => {
      await admin`
        insert into tenant_categories (tenant_id, category_id) values
          (${TENANT}, ${PLACE_KIND}), (${TENANT}, ${MODULE_TILE})`;
      const rows = await admin`
        select 1 from tenant_categories where tenant_id = ${TENANT}`;
      expect(rows).toHaveLength(3);
    });
  });

  it('stores searchable_fields with an empty default (C3)', async () => {
    const [row] = await admin<{ searchable_fields: string[] }[]>`
      select searchable_fields from category_field_schemas where id = ${FIELD_SCHEMA}`;
    expect(row?.searchable_fields).toEqual(['brand']);
  });

  it('seeds place_reverify_after_days as a tenant-overridable day count (C7)', async () => {
    const [row] = await admin<{ value: unknown; scope: string; unit: string }[]>`
      select value, tenant_override_scope_code as scope, unit
      from platform_settings where key = 'place_reverify_after_days'`;
    expect(row).toEqual({ value: 180, scope: 'tenant_admin', unit: 'days' });
  });

  describe('category_modules RLS (enum table)', () => {
    it('is readable by a member', async () => {
      const rows = await asMember(app, (tx) => tx`select code from category_modules`);
      expect(rows.length).toBeGreaterThanOrEqual(3);
    });

    it('rejects writes from anyone but a platform admin', async () => {
      const error = await asMember(
        app,
        (tx) => tx`insert into category_modules (code, label_key) values ('sneaky', 'x')`,
      ).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(error?.code).toBe('42501');
    });
  });
});

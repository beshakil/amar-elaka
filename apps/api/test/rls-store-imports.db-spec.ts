import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS for bulk import (0052_store_import_and_catalog.sql): store_imports and
 * store_import_rows. Whoever may post as the store starts an import as
 * themselves; they see their own, the store's owner/managers see all of the
 * store's; nobody but the worker (system) writes progress or rows; nothing
 * crosses tenants.
 */

const P = '0191e3a0-a0d3-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U_OWNER = `${P}000000000031`;
const U_EDITOR = `${P}000000000032`;
const U_STRANGER = `${P}000000000033`;
const U_B = `${P}000000000034`;
const M_OWNER = `${P}000000000041`;
const M_EDITOR = `${P}000000000042`;
const M_STRANGER = `${P}000000000043`;
const M_B = `${P}000000000044`;
const STORE = `${P}000000000051`;
const CATEGORY = `${P}000000000061`;
const IMPORT_EDITOR = `${P}000000000071`;
const IMPORT_OWNER = `${P}000000000072`;

type Context = Partial<Record<'tenant_id' | 'user_id' | 'member_id' | 'role', string>>;

const as = (tenant: string, user: string, member: string): Context => ({
  tenant_id: tenant,
  user_id: user,
  member_id: member,
  role: 'member',
});
const AS_OWNER = as(TENANT_A, U_OWNER, M_OWNER);
const AS_EDITOR = as(TENANT_A, U_EDITOR, M_EDITOR);
const AS_STRANGER = as(TENANT_A, U_STRANGER, M_STRANGER);
const AS_TENANT_B = as(TENANT_B, U_B, M_B);
const AS_SYSTEM: Context = { tenant_id: TENANT_A, role: 'system' };

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

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  expect(error.code).toBe('42501');
}

const importIds = (tx: TransactionSql) =>
  tx<{ id: string }[]>`select id from store_imports where store_id = ${STORE} order by id`.then(
    (rows) => rows.map((row) => row.id),
  );

describe('Row level security: store imports (0052)', () => {
  let app: Sql;
  let admin: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from store_import_rows where tenant_id::text like ${FIXTURE}`;
    await admin`delete from store_imports where tenant_id::text like ${FIXTURE}`;
    await admin`delete from store_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values
      (${U_OWNER}, '+8801745000001'), (${U_EDITOR}, '+8801745000002'),
      (${U_STRANGER}, '+8801745000003'), (${U_B}, '+8801745000004')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Imports Fixture', 'Imports Fixture', '+8801745000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'rls-imports-a', 'RLS Imports A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'rls-imports-b', 'RLS Imports B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'rls-imports-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'rls-imports-b', 'বি', 'B', st_point(90.5, 23.9)::geography, 'active')`;
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M_OWNER}, ${TENANT_A}, ${U_OWNER}, 'member'), (${M_EDITOR}, ${TENANT_A}, ${U_EDITOR}, 'member'),
      (${M_STRANGER}, ${TENANT_A}, ${U_STRANGER}, 'member'), (${M_B}, ${TENANT_B}, ${U_B}, 'member')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'rls-imports-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_A}, ${M_OWNER}, 'rls-imports-store', 'দোকান', 'active')`;
    });
    await admin`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at)
                values (${TENANT_A}, ${STORE}, ${M_EDITOR}, 'editor', now())`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  const insertImport = (tx: TransactionSql, id: string, member: string) =>
    tx`insert into store_imports (id, tenant_id, store_id, category_id, created_by_member_id, sheet_format)
       values (${id}, ${TENANT_A}, ${STORE}, ${CATEGORY}, ${member}, 'csv')`;

  it('lets a store poster start an import as themselves, and nobody else', async () => {
    await withContext(app, AS_EDITOR, (tx) => insertImport(tx, IMPORT_EDITOR, M_EDITOR));
    await withContext(app, AS_OWNER, (tx) => insertImport(tx, IMPORT_OWNER, M_OWNER));
    // Not in someone else's name, not without posting rights, not from another tenant.
    await expectDenied(
      withContext(app, AS_EDITOR, (tx) => insertImport(tx, `${P}000000000079`, M_OWNER)),
    );
    await expectDenied(
      withContext(app, AS_STRANGER, (tx) => insertImport(tx, `${P}000000000079`, M_STRANGER)),
    );
    await expectDenied(
      withContext(app, AS_TENANT_B, (tx) => insertImport(tx, `${P}000000000079`, M_B)),
    );
  });

  it('shows an editor their own imports, the owner all of them, a stranger none', async () => {
    expect(await withContext(app, AS_EDITOR, importIds)).toEqual([IMPORT_EDITOR]);
    expect(await withContext(app, AS_OWNER, importIds)).toEqual([IMPORT_EDITOR, IMPORT_OWNER]);
    expect(await withContext(app, AS_STRANGER, importIds)).toEqual([]);
  });

  it('only the worker records progress and rows', async () => {
    const forged = await withContext(
      app,
      AS_EDITOR,
      (tx) =>
        tx`update store_imports set status_code = 'succeeded', created_count = 99 where id = ${IMPORT_EDITOR}`,
    );
    expect(forged.count).toBe(0);
    await expectDenied(
      withContext(
        app,
        AS_EDITOR,
        (tx) => tx`insert into store_import_rows (tenant_id, import_id, row_number, outcome)
                   values (${TENANT_A}, ${IMPORT_EDITOR}, 1, 'created')`,
      ),
    );

    await withContext(app, AS_SYSTEM, async (tx) => {
      await tx`update store_imports set status_code = 'succeeded', total_rows = 2 where id in ${tx([IMPORT_EDITOR, IMPORT_OWNER])}`;
      await tx`insert into store_import_rows (tenant_id, import_id, row_number, outcome, reason_code, reason) values
        (${TENANT_A}, ${IMPORT_EDITOR}, 1, 'failed', 'missing_title', 'title'),
        (${TENANT_A}, ${IMPORT_OWNER}, 1, 'skipped', 'blank_row', 'blank')`;
    });
  });

  it('rows follow their import: visible exactly where the import is', async () => {
    const rowsOf = (tx: TransactionSql) =>
      tx<
        { import_id: string }[]
      >`select import_id from store_import_rows where tenant_id = ${TENANT_A} order by import_id`.then(
        (rows) => rows.map((row) => row.import_id),
      );
    expect(await withContext(app, AS_EDITOR, rowsOf)).toEqual([IMPORT_EDITOR]);
    expect(await withContext(app, AS_OWNER, rowsOf)).toEqual([IMPORT_EDITOR, IMPORT_OWNER]);
    expect(await withContext(app, AS_STRANGER, rowsOf)).toEqual([]);
  });

  it('nothing crosses tenants', async () => {
    const seen = await withContext(app, AS_TENANT_B, async (tx) => ({
      imports: await tx`select id from store_imports where tenant_id = ${TENANT_A}`,
      rows: await tx`select id from store_import_rows where tenant_id = ${TENANT_A}`,
    }));
    expect(seen.imports).toHaveLength(0);
    expect(seen.rows).toHaveLength(0);
    // Not even by naming tenant A's store from tenant B's context.
    const asOwnerInB = await withContext(app, { ...AS_OWNER, tenant_id: TENANT_B }, importIds);
    expect(asOwnerInB).toEqual([]);
  });
});

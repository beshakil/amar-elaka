import type { Sql, TransactionSql } from 'postgres';
import { STOCK_STATUSES } from '../src/posts/post-stock';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS for 0053 (ADR 057): a store's owner and accepted managers read and
 * update every post of their store, whoever wrote it — never a legal hold,
 * never a personal post, never to move it out of the store, never an insert
 * in someone else's name; an editor keeps author-only access; nothing
 * crosses tenants. Plus the stock_statuses lookup.
 */

const P = '0191e3a0-a0d4-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U = (n: number) => `${P}0000000000${30 + n}`;
const M = (n: number) => `${P}0000000000${40 + n}`;
const [OWNER, MANAGER, EDITOR, STRANGER, MEMBER_B] = [1, 2, 3, 4, 5];
const STORE = `${P}000000000051`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const POST_EDITOR = `${P}000000000071`;
const POST_OWNER = `${P}000000000072`;
const POST_PERSONAL = `${P}000000000073`;
const POST_HELD = `${P}000000000074`;

type Context = Partial<Record<'tenant_id' | 'user_id' | 'member_id' | 'role', string>>;
const as = (n: number, tenant = TENANT_A): Context => ({
  tenant_id: tenant,
  user_id: U(n),
  member_id: M(n),
  role: 'member',
});

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

async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (caught: unknown) => (caught as { code?: string }).code ?? 'unknown',
  );
}

const visible = (tx: TransactionSql) =>
  tx<{ id: string }[]>`select id from posts where id::text like ${FIXTURE} order by id`.then(
    (rows) => rows.map((r) => r.id),
  );

describe('Row level security: store managers run the store’s posts (0053)', () => {
  let app: Sql;
  let admin: Sql;

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from posts where tenant_id::text like ${FIXTURE}`;
      await tx`delete from store_members where tenant_id::text like ${FIXTURE}`;
      await tx`delete from stores where tenant_id::text like ${FIXTURE}`;
      await tx`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
      await tx`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
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
    for (const n of [OWNER, MANAGER, EDITOR, STRANGER, MEMBER_B]) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017460000${n}0`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Managers Fixture', 'Managers Fixture', '+8801746000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'rls-managers-a', 'RLS Managers A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'rls-managers-b', 'RLS Managers B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'rls-managers-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'rls-managers-b', 'বি', 'B', st_point(90.5, 23.9)::geography, 'active')`;
    for (const n of [OWNER, MANAGER, EDITOR, STRANGER]) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT_A}, ${U(n)}, 'member')`;
    }
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(MEMBER_B)}, ${TENANT_B}, ${U(MEMBER_B)}, 'member')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'rls-managers-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT_A}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_A}, ${M(OWNER)}, 'rls-managers-store', 'দোকান', 'active')`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at) values
        (${TENANT_A}, ${STORE}, ${M(MANAGER)}, 'manager', now()),
        (${TENANT_A}, ${STORE}, ${M(EDITOR)}, 'editor', now())`;
      for (const [id, author, store, deletion] of [
        [POST_EDITOR, M(EDITOR), STORE, null],
        [POST_OWNER, M(OWNER), STORE, null],
        [POST_PERSONAL, M(EDITOR), null, null],
        [POST_HELD, M(EDITOR), STORE, 'legal_hold'],
      ] as const) {
        await tx`insert into posts (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title,
                                    status_code, location, fields, deleted_at, deletion_reason_code)
                 values (${id}, ${TENANT_A}, ${author}, ${store}, ${CATEGORY}, ${SCHEMA}, 'খসড়া', 'draft',
                         st_point(90.4, 23.8)::geography, '{}'::jsonb,
                         ${deletion ? new Date() : null}, ${deletion})`;
      }
    });
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  it('the owner and a manager see every non-held post of the store; an editor and a stranger see only their own', async () => {
    expect(await withContext(app, as(OWNER), visible)).toEqual([POST_EDITOR, POST_OWNER]);
    expect(await withContext(app, as(MANAGER), visible)).toEqual([POST_EDITOR, POST_OWNER]);
    // The editor's own (store and personal; the legal hold stays platform-only), not the owner's draft.
    expect(await withContext(app, as(EDITOR), visible)).toEqual([POST_EDITOR, POST_PERSONAL]);
    expect(await withContext(app, as(STRANGER), visible)).toEqual([]);
  });

  it("a manager updates an editor's store post; nobody else's personal post, nor via a stranger", async () => {
    const byManager = await withContext(
      app,
      as(MANAGER),
      (tx) =>
        tx`update posts set stock_status_code = 'out_of_stock', hidden_by_owner = true where id = ${POST_EDITOR}`,
    );
    expect(byManager.count).toBe(1);
    const [row] = await admin<{ stock_status_code: string; hidden_by_owner: boolean }[]>`
      select stock_status_code, hidden_by_owner from posts where id = ${POST_EDITOR}`;
    expect(row).toEqual({ stock_status_code: 'out_of_stock', hidden_by_owner: true });

    const personal = await withContext(
      app,
      as(MANAGER),
      (tx) => tx`update posts set title = 'x' where id = ${POST_PERSONAL}`,
    );
    expect(personal.count).toBe(0);
    const stranger = await withContext(
      app,
      as(STRANGER),
      (tx) => tx`update posts set title = 'x' where id = ${POST_EDITOR}`,
    );
    expect(stranger.count).toBe(0);
    // An editor isn't a manager: the owner's post is not theirs to change.
    const editor = await withContext(
      app,
      as(EDITOR),
      (tx) => tx`update posts set title = 'x' where id = ${POST_OWNER}`,
    );
    expect(editor.count).toBe(0);
  });

  it('a manager cannot take a post out of the store, touch a legal hold, or post in an editor’s name', async () => {
    expect(
      await rejection(
        withContext(
          app,
          as(MANAGER),
          (tx) => tx`update posts set store_id = null where id = ${POST_EDITOR}`,
        ),
      ),
    ).toBe('42501');
    const held = await withContext(
      app,
      as(MANAGER),
      (tx) => tx`update posts set title = 'x' where id = ${POST_HELD}`,
    );
    expect(held.count).toBe(0);
    expect(
      await rejection(
        withContext(
          app,
          as(MANAGER),
          (
            tx,
          ) => tx`insert into posts (tenant_id, author_member_id, store_id, category_id, field_schema_id, title, status_code, location, fields)
                     values (${TENANT_A}, ${M(EDITOR)}, ${STORE}, ${CATEGORY}, ${SCHEMA}, 'নকল', 'draft',
                             st_point(90.4, 23.8)::geography, '{}'::jsonb)`,
        ),
      ),
    ).toBe('42501');
  });

  it('nothing crosses tenants, not even for the store’s manager', async () => {
    expect(await withContext(app, as(MEMBER_B, TENANT_B), visible)).toEqual([]);
    expect(await withContext(app, as(MANAGER, TENANT_B), visible)).toEqual([]);
    const across = await withContext(
      app,
      as(MANAGER, TENANT_B),
      (tx) => tx`update posts set title = 'x' where id = ${POST_EDITOR}`,
    );
    expect(across.count).toBe(0);
  });

  it('stock_statuses: the lookup is the TypeScript list, and the column refuses anything else', async () => {
    const codes = await withContext(app, as(STRANGER), (tx) =>
      tx<{ code: string }[]>`select code from stock_statuses order by sort_order`.then((rows) =>
        rows.map((r) => r.code),
      ),
    );
    expect(codes).toEqual([...STOCK_STATUSES]);
    expect(
      await rejection(
        admin`update posts set stock_status_code = 'sold_out' where id = ${POST_OWNER}`,
      ),
    ).toBe('23503');
  });
});

import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * The stores module in the database (0050, ADR 054), as the application's
 * own connection (ae_app) sees it: the tier and the one slug change are the
 * database's to enforce, a store's status reaches its posts (store_hidden →
 * post_is_listed), the "may post as this store" rule, the invite function,
 * my_stores() / store_staff() and the new RLS policies — each with a
 * cross-tenant check (CLAUDE.md "every RLS policy needs a test").
 */

const P = '0191e3a0-a0b8-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U_OWNER = `${P}000000000031`;
const U_MANAGER = `${P}000000000032`;
const U_EDITOR = `${P}000000000033`;
const U_STRANGER = `${P}000000000034`;
const U_B = `${P}000000000035`;
const M_OWNER = `${P}000000000041`;
const M_MANAGER = `${P}000000000042`;
const M_EDITOR = `${P}000000000043`;
const M_STRANGER = `${P}000000000044`;
const M_B = `${P}000000000045`;
const M_OWNER_B = `${P}000000000046`;
const STORE = `${P}000000000051`;
const STORE_B = `${P}000000000052`;
const PLACE = `${P}000000000061`;
const PLACE_B = `${P}000000000062`;
const PLACE_CATEGORY = `${P}000000000071`;
const POST_CATEGORY = `${P}000000000072`;
const SCHEMA = `${P}000000000081`;
const POST = `${P}000000000091`;

type Context = Partial<Record<'tenant_id' | 'user_id' | 'member_id' | 'role', string>>;
const as = (tenant: string, user: string, member: string, role = 'member'): Context => ({
  tenant_id: tenant,
  user_id: user,
  member_id: member,
  role,
});
const OWNER = as(TENANT_A, U_OWNER, M_OWNER);
const MANAGER = as(TENANT_A, U_MANAGER, M_MANAGER);
const EDITOR = as(TENANT_A, U_EDITOR, M_EDITOR);
const STRANGER = as(TENANT_A, U_STRANGER, M_STRANGER);
const IN_B = as(TENANT_B, U_B, M_B);
const MODERATOR = as(TENANT_A, U_STRANGER, M_STRANGER, 'moderator');

async function stateOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: { code?: string }) => error.code ?? 'unknown',
  );
}

describe('stores in the database (0050)', () => {
  let app: Sql;
  let admin: Sql;

  const withContext = <T>(context: Context, work: (tx: TransactionSql) => Promise<T>): Promise<T> =>
    app.begin(async (tx) => {
      for (const [key, value] of Object.entries(context)) {
        await tx`select set_config(${`app.${key}`}, ${value}, true)`;
      }
      return work(tx);
    }) as Promise<T>;

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
      await tx`delete from posts where tenant_id::text like ${FIXTURE}`;
      await tx`delete from store_members where tenant_id::text like ${FIXTURE}`;
      await tx`delete from place_revisions where tenant_id::text like ${FIXTURE}`;
      await tx`delete from places where tenant_id::text like ${FIXTURE}`;
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
    await admin`delete from user_profiles where user_id in (select id from users where phone_e164 = '+8801788100009')`;
    await admin`delete from users where id::text like ${FIXTURE} or phone_e164 = '+8801788100009'`;
  }

  beforeAll(async () => {
    app = testSqlClient(2, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164) values
        (${U_OWNER}, '+8801788100001'), (${U_MANAGER}, '+8801788100002'), (${U_EDITOR}, '+8801788100003'),
        (${U_STRANGER}, '+8801788100004'), (${U_B}, '+8801788100005')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Stores DB', 'Stores DB', '+8801788100099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${AREA_A}, 3, 'upazila', 'stores-db-a', 'Stores DB A', 'fixture'),
        (${AREA_B}, 3, 'upazila', 'stores-db-b', 'Stores DB B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'stores-db-a', 'এ', 'A', st_point(89.1, 24.1)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'stores-db-b', 'বি', 'B', st_point(89.3, 24.1)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT_A}, ${U_OWNER}, 'member'), (${M_MANAGER}, ${TENANT_A}, ${U_MANAGER}, 'member'),
        (${M_EDITOR}, ${TENANT_A}, ${U_EDITOR}, 'member'), (${M_STRANGER}, ${TENANT_A}, ${U_STRANGER}, 'member'),
        (${M_B}, ${TENANT_B}, ${U_B}, 'member'), (${M_OWNER_B}, ${TENANT_B}, ${U_OWNER}, 'member')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en)
                values (${PLACE_CATEGORY}, 'place', 'stores-db-shop', 'দোকান', 'Shop')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
      values (${POST_CATEGORY}, 'marketplace', 'stores-db-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${POST_CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location) values
          (${STORE}, ${TENANT_A}, ${M_OWNER}, 'stores-db-store', 'দোকান', 'active', st_point(89.1, 24.1)::geography),
          (${STORE_B}, ${TENANT_B}, ${M_OWNER_B}, 'stores-db-store', 'দোকান বি', 'active', st_point(89.3, 24.1)::geography)`;
      await tx`
        insert into places (id, tenant_id, category_id, slug, name_bn, status_code, location, source_code,
                            claimed_by_member_id, claim_store_id) values
          (${PLACE}, ${TENANT_A}, ${PLACE_CATEGORY}, 'stores-db-pin', 'দোকান', 'published',
           st_point(89.1, 24.1)::geography, 'owner_created', ${M_OWNER}, ${STORE}),
          (${PLACE_B}, ${TENANT_B}, ${PLACE_CATEGORY}, 'stores-db-pin-b', 'দোকান বি', 'published',
           st_point(89.3, 24.1)::geography, 'owner_created', ${M_OWNER_B}, ${STORE_B})`;
      await tx`update stores set place_id = ${PLACE} where id = ${STORE}`;
      await tx`update stores set place_id = ${PLACE_B} where id = ${STORE_B}`;
      await tx`
        insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at) values
          (${TENANT_A}, ${STORE}, ${M_MANAGER}, 'manager', now()),
          (${TENANT_A}, ${STORE}, ${M_EDITOR}, 'editor', now())`;
    });
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await app.end();
      await admin.end();
    }
  });

  // ---- lookups ----------------------------------------------------------------------

  it('store_tiers: everyone reads it, only platform admins write it', async () => {
    const tiers = await withContext(
      STRANGER,
      (tx) => tx<{ code: string }[]>`select code from store_tiers order by sort_order`,
    );
    expect(tiers.map((t) => t.code)).toEqual(['basic', 'pro', 'premium']);
    const denied = await stateOf(
      withContext(
        STRANGER,
        (tx) => tx`insert into store_tiers (code, label_key) values ('gold', 'x')`,
      ),
    );
    expect(denied).toBe('42501');
  });

  it("'staff' is retired for 'editor'", async () => {
    const roles = await admin<{ code: string; is_active: boolean }[]>`
      select code, is_active from store_member_roles order by sort_order`;
    expect(roles).toEqual([
      { code: 'manager', is_active: true },
      { code: 'editor', is_active: true },
      { code: 'staff', is_active: false },
    ]);
  });

  // ---- tier and slug ---------------------------------------------------------------

  it('the owner cannot move the tier; the slug changes once, keeping the old one', async () => {
    await withContext(
      OWNER,
      (tx) => tx`update stores set tier_code = 'premium' where id = ${STORE}`,
    );
    await withContext(
      OWNER,
      (tx) => tx`update stores set slug = 'stores-db-renamed' where id = ${STORE}`,
    );
    const [row] = await admin<
      { tier_code: string; slug: string; previous_slug: string; changed: boolean }[]
    >`
      select tier_code, slug, previous_slug, slug_changed_at is not null as changed from stores where id = ${STORE}`;
    expect(row).toEqual({
      tier_code: 'basic',
      slug: 'stores-db-renamed',
      previous_slug: 'stores-db-store',
      changed: true,
    });

    const again = await stateOf(
      withContext(
        OWNER,
        (tx) => tx`update stores set slug = 'stores-db-third' where id = ${STORE}`,
      ),
    );
    expect(again).toBe('AE240');
    // Nor can the change be undone by clearing the stamp.
    await withContext(
      OWNER,
      (tx) => tx`update stores set slug_changed_at = null where id = ${STORE}`,
    );
    const [stamp] = await admin<{ changed: boolean }[]>`
      select slug_changed_at is not null as changed from stores where id = ${STORE}`;
    expect(stamp!.changed).toBe(true);
  });

  it('a slug is unique within a tenant only, the old one stays taken, and route names are refused', async () => {
    const free = (ctx: Context, slug: string) =>
      withContext(
        ctx,
        (tx) => tx<{ ok: boolean }[]>`select public.store_slug_available(${slug}, null) as ok`,
      );
    expect((await free(STRANGER, 'stores-db-renamed'))[0]!.ok).toBe(false);
    expect((await free(STRANGER, 'stores-db-store'))[0]!.ok).toBe(false); // the old slug
    expect((await free(IN_B, 'stores-db-renamed'))[0]!.ok).toBe(true);
    const duplicate = await stateOf(
      admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into stores (tenant_id, owner_member_id, slug, name_bn) values (${TENANT_A}, ${M_STRANGER}, 'stores-db-renamed', 'x')`;
      }),
    );
    expect(duplicate).toBe('23505');
    const reserved = await stateOf(
      admin`insert into stores (tenant_id, owner_member_id, slug, name_bn) values (${TENANT_A}, ${M_STRANGER}, 'me', 'x')`,
    );
    expect(reserved).toBe('23514');
  });

  // ---- posting as the store ---------------------------------------------------------

  const insertPost = (ctx: Context, member: string, id: string | null = null) =>
    withContext(
      ctx,
      (tx) => tx`
      insert into posts (id, author_member_id, store_id, category_id, field_schema_id,
                         title, status_code, location, price_type_code)
      values (coalesce(${id}::uuid, public.uuid_generate_v7()), ${member}, ${STORE}, ${POST_CATEGORY},
              ${SCHEMA}, 'দোকানের পোস্ট', 'draft', st_point(89.1, 24.1)::geography, 'fixed')`,
    );

  it('only the owner and accepted staff post as the store (AE246)', async () => {
    expect(await stateOf(insertPost(STRANGER, M_STRANGER))).toBe('AE246');
    expect(await stateOf(insertPost(EDITOR, M_EDITOR, POST))).toBeUndefined();
    const [facts] = await withContext(
      EDITOR,
      (tx) => tx<{ may_post: boolean; catalog_count: number }[]>`
      select may_post, catalog_count from public.store_posting_facts(${STORE})`,
    );
    expect(facts).toEqual({ may_post: true, catalog_count: 1 });
    const [stranger] = await withContext(
      STRANGER,
      (tx) => tx<{ may_post: boolean }[]>`
      select may_post from public.store_posting_facts(${STORE})`,
    );
    expect(stranger!.may_post).toBe(false);
  });

  it("a store's status reaches its posts, and an author can't clear it", async () => {
    await admin`update posts set status_code = 'live', published_at = now() where id = ${POST}`;
    const listed = async () =>
      (
        await admin<{ listed: boolean; hidden: boolean }[]>`
          select store_hidden as hidden,
                 public.post_is_listed(status_code, deleted_at, scrubbed_at, hidden_by_owner, store_hidden, expires_at, now()) as listed
          from posts where id = ${POST}`
      )[0]!;
    expect(await listed()).toEqual({ listed: true, hidden: false });

    await withContext(
      MODERATOR,
      (tx) => tx`update stores set status_code = 'suspended' where id = ${STORE}`,
    );
    expect(await listed()).toEqual({ listed: false, hidden: true });
    const [event] = await admin<{ n: string }[]>`
      select count(*) as n from outbox_events where aggregate_id = ${POST} and event_type = 'search.sync' and processed_at is null`;
    expect(Number(event!.n)).toBeGreaterThan(0);

    await withContext(EDITOR, (tx) => tx`update posts set store_hidden = false where id = ${POST}`);
    expect((await listed()).hidden).toBe(true);

    await withContext(
      MODERATOR,
      (tx) => tx`update stores set status_code = 'active' where id = ${STORE}`,
    );
    expect(await listed()).toEqual({ listed: true, hidden: false });
  });

  it('the six-argument post_is_listed is gone: nothing can skip the store', async () => {
    const [row] = await admin<{ n: string }[]>`
      select count(*) as n from pg_proc where proname = 'post_is_listed' and pronargs = 6`;
    expect(Number(row!.n)).toBe(0);
  });

  // ---- staff ------------------------------------------------------------------------

  it('store_invite_staff: owner any role, manager editors only, editor nothing; a new number gets an account', async () => {
    const invite = (ctx: Context, phone: string, role: string) =>
      withContext(
        ctx,
        (tx) => tx`select * from public.store_invite_staff(${STORE}, ${phone}, ${role}, 10)`,
      );
    expect(await stateOf(invite(EDITOR, '+8801788100009', 'editor'))).toBe('AE241');
    expect(await stateOf(invite(MANAGER, '+8801788100009', 'manager'))).toBe('AE241');
    expect(await stateOf(invite(OWNER, '+8801788100003', 'editor'))).toBe('AE244'); // already staff
    expect(await stateOf(invite(OWNER, '+8801788100001', 'editor'))).toBe('AE244'); // the owner
    expect(
      await stateOf(
        withContext(
          OWNER,
          (tx) =>
            tx`select * from public.store_invite_staff(${STORE}, '+8801788100009', 'editor', 2)`,
        ),
      ),
    ).toBe('AE243');

    const [created] = (await invite(MANAGER, '+8801788100009', 'editor')) as unknown as {
      user_created: boolean;
      member_id: string;
    }[];
    expect(created!.user_created).toBe(true);
    const [pending] = await admin<{ role_code: string; accepted: boolean; verified: boolean }[]>`
      select sm.role_code, sm.accepted_at is not null as accepted, u.phone_verified_at is not null as verified
      from store_members sm join tenant_members tm on tm.id = sm.member_id join users u on u.id = tm.user_id
      where sm.store_id = ${STORE} and u.phone_e164 = '+8801788100009'`;
    expect(pending).toEqual({ role_code: 'editor', accepted: false, verified: false });
  });

  it('store_staff: the owner and managers see the staff, editors and other tenants nothing', async () => {
    const staff = (ctx: Context) =>
      withContext(
        ctx,
        (tx) => tx<{ member_id: string }[]>`select member_id from public.store_staff(${STORE})`,
      );
    expect((await staff(OWNER)).length).toBe(3);
    expect((await staff(MANAGER)).length).toBe(3);
    expect(await staff(EDITOR)).toEqual([]);
    expect(await staff(IN_B)).toEqual([]);
  });

  it('my_stores: my own rows in every tenant, nobody else’s', async () => {
    const owner = await withContext(
      OWNER,
      (tx) => tx<{ store_id: string; role_code: string }[]>`
      select store_id, role_code from public.my_stores()`,
    );
    expect(owner.map((r) => [r.store_id, r.role_code]).sort()).toEqual(
      [
        [STORE, 'owner'],
        [STORE_B, 'owner'],
      ].sort(),
    );
    const editor = await withContext(
      EDITOR,
      (tx) => tx<{ store_id: string; role_code: string }[]>`
      select store_id, role_code from public.my_stores()`,
    );
    expect(editor).toEqual([{ store_id: STORE, role_code: 'editor' }]);
    expect(await withContext(IN_B, (tx) => tx`select * from public.my_stores()`)).toHaveLength(0);
  });

  // ---- the new RLS policies, across tenants ----------------------------------------

  it("places_store_manager_update: a manager edits the store's pin — not another tenant's", async () => {
    const own = await withContext(
      MANAGER,
      (tx) => tx`update places set name_en = 'Pin A' where id = ${PLACE}`,
    );
    expect(own.count).toBe(1);
    const editor = await withContext(
      EDITOR,
      (tx) => tx`update places set name_en = 'Nope' where id = ${PLACE}`,
    );
    expect(editor.count).toBe(0);
    // Another tenant's store pin: the manager's context can't reach it.
    const other = await withContext(
      MANAGER,
      (tx) => tx`update places set name_en = 'Nope' where id = ${PLACE_B}`,
    );
    expect(other.count).toBe(0);
    const [pinB] = await admin<
      { name_en: string | null }[]
    >`select name_en from places where id = ${PLACE_B}`;
    expect(pinB!.name_en).toBeNull();
  });

  it('store_members_self_delete: staff leave on their own, not for others, not in another tenant', async () => {
    const forOther = await withContext(
      EDITOR,
      (tx) => tx`
      delete from store_members where store_id = ${STORE} and member_id = ${M_MANAGER}`,
    );
    expect(forOther.count).toBe(0);
    const crossTenant = await withContext(
      as(TENANT_B, U_EDITOR, M_EDITOR),
      (tx) => tx`
      delete from store_members where store_id = ${STORE} and member_id = ${M_EDITOR}`,
    );
    expect(crossTenant.count).toBe(0);
    const self = await withContext(
      EDITOR,
      (tx) => tx`
      delete from store_members where store_id = ${STORE} and member_id = ${M_EDITOR}`,
    );
    expect(self.count).toBe(1);
  });

  it('moderation_actions can target a store (exactly one target)', async () => {
    const both = await stateOf(
      withContext(
        MODERATOR,
        (tx) => tx`
      insert into moderation_actions (store_id, post_id, actor_user_id, action_code, reason_code)
      values (${STORE}, ${POST}, ${U_STRANGER}, 'store_suspended', 'spam')`,
      ),
    );
    expect(both).toBe('23514');
    const one = await withContext(
      MODERATOR,
      (tx) => tx`
      insert into moderation_actions (store_id, actor_user_id, action_code, reason_code)
      values (${STORE}, ${U_STRANGER}, 'store_suspended', 'spam')`,
    );
    expect(one.count).toBe(1);
  });
});

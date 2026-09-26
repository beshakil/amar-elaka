import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0026 against real Postgres: the text_array setting type and the
 * SECURITY DEFINER helpers the posts module relies on for posts that live in
 * a neighbouring tenant (§13.26) — each acts only for app.user_id and never
 * widens what the caller can read beyond ids/codes.
 */

const FIXTURE = '0191e3a0-9057-7000-8000-%';
const PARTNER = '0191e3a0-9057-7000-8000-000000000001';
const AREA_A = '0191e3a0-9057-7000-8000-000000000011';
const AREA_B = '0191e3a0-9057-7000-8000-000000000012';
const TENANT_A = '0191e3a0-9057-7000-8000-000000000021';
const TENANT_B = '0191e3a0-9057-7000-8000-000000000022';
const USER = '0191e3a0-9057-7000-8000-000000000031';
const STRANGER = '0191e3a0-9057-7000-8000-000000000032';
const MEMBER_A = '0191e3a0-9057-7000-8000-000000000041';
const CATEGORY = '0191e3a0-9057-7000-8000-000000000051';
const SCHEMA = '0191e3a0-9057-7000-8000-000000000061';
const POST_A_LIVE = '0191e3a0-9057-7000-8000-000000000101';
const POST_A_DRAFT = '0191e3a0-9057-7000-8000-000000000102';
const POST_A_DELETED = '0191e3a0-9057-7000-8000-000000000103';
const POST_A_HELD = '0191e3a0-9057-7000-8000-000000000104';
const POST_B_PENDING = '0191e3a0-9057-7000-8000-000000000105';

type Context = Record<string, string>;
const asUser = (userId: string, tenantId: string = TENANT_A): Context => ({
  tenant_id: tenantId,
  user_id: userId,
  role: 'member',
});

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

describe('Posts module database helpers (0026)', () => {
  let admin: Sql;
  let app: Sql;
  let memberB: string;

  async function cleanUp(): Promise<void> {
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
    await admin`insert into users (id, phone_e164) values (${USER}, '+8801755000001'), (${STRANGER}, '+8801755000002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Posts DB Partner', 'Posts DB Partner', '+8801755000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${AREA_A}, 3, 'upazila', 'posts-db-a', 'Posts DB A', 'fixture'),
        (${AREA_B}, 3, 'upazila', 'posts-db-b', 'Posts DB B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'posts-db-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'posts-db-b', 'বি', 'B', st_point(90.5, 23.9)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER_A}, ${TENANT_A}, ${USER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'posts-db-category', 'বিভাগ', 'Category')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    const post = (id: string, tenant: string, member: string, extra: string) =>
      admin.unsafe(`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
                         published_at, deleted_at, deletion_reason_code)
      values ('${id}', '${tenant}', '${member}', '${CATEGORY}', '${SCHEMA}', 'db post', ${extra})`);
    await post(POST_A_LIVE, TENANT_A, MEMBER_A, `'live', now(), null, null`);
    await post(POST_A_DRAFT, TENANT_A, MEMBER_A, `'draft', null, null, null`);
    await post(POST_A_DELETED, TENANT_A, MEMBER_A, `'live', now(), now(), 'user_deleted'`);
    await post(POST_A_HELD, TENANT_A, MEMBER_A, `'removed', null, now(), 'legal_hold'`);
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('text_array settings', () => {
    it('stores post_rereview_fields as a list of strings and rejects anything else', async () => {
      const [row] = await admin<{ value: string[] }[]>`
        select value from platform_settings where key = 'post_rereview_fields'`;
      expect(row!.value).toEqual(['title', 'media', 'price', 'category']);
      const [check] = await admin<{ ok: boolean; bad: boolean; notArray: boolean }[]>`
        select public.setting_value_matches_type('["a","b"]', 'text_array') as ok,
               public.setting_value_matches_type('["a", 1]', 'text_array') as bad,
               public.setting_value_matches_type('"a"', 'text_array') as "notArray"`;
      expect(check).toEqual({ ok: true, bad: false, notArray: false });
    });
  });

  describe('ensure_my_membership / my_membership_in', () => {
    it('creates the implicit membership in the owning tenant once, then reuses it', async () => {
      const [first] = await as(
        app,
        asUser(USER),
        (tx) => tx<{ member_id: string; role_code: string }[]>`
        select * from public.ensure_my_membership(${TENANT_B})`,
      );
      const [again] = await as(
        app,
        asUser(USER),
        (tx) => tx<{ member_id: string }[]>`
        select * from public.ensure_my_membership(${TENANT_B})`,
      );
      expect(first).toMatchObject({ role_code: 'member' });
      expect(again!.member_id).toBe(first!.member_id);
      memberB = first!.member_id;

      const [looked] = await as(
        app,
        asUser(USER),
        (tx) => tx<{ member_id: string }[]>`
        select * from public.my_membership_in(${TENANT_B})`,
      );
      expect(looked!.member_id).toBe(memberB);
    });

    it('never acts without a signed-in user, and a stranger has no membership to find', async () => {
      await expect(
        as(
          app,
          { role: 'anon' },
          (tx) => tx`select * from public.ensure_my_membership(${TENANT_B})`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const rows = await as(
        app,
        asUser(STRANGER),
        (tx) => tx`select * from public.my_membership_in(${TENANT_B})`,
      );
      expect(rows).toHaveLength(0);
    });

    it('is still blocked by RLS when attempted directly', async () => {
      await expect(
        as(
          app,
          asUser(USER),
          (tx) => tx`
          insert into tenant_members (tenant_id, user_id, role_code) values (${TENANT_B}, ${STRANGER}, 'member')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('post_tenant_of', () => {
    it('names the tenant of any post, from any tenant — but never a legal-hold post', async () => {
      const [live] = await as(
        app,
        asUser(STRANGER, TENANT_B),
        (tx) => tx<{ t: string | null }[]>`
        select public.post_tenant_of(${POST_A_LIVE}) as t`,
      );
      expect(live!.t).toBe(TENANT_A);
      const [held] = await as(
        app,
        asUser(USER),
        (tx) => tx<{ t: string | null }[]>`
        select public.post_tenant_of(${POST_A_HELD}) as t`,
      );
      expect(held!.t).toBeNull();
    });
  });

  describe('my_post_refs / my_post_stats / my_post_counts', () => {
    beforeAll(async () => {
      await admin`
        insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code)
        values (${POST_B_PENDING}, ${TENANT_B}, ${memberB}, ${CATEGORY}, ${SCHEMA}, 'db post in B', 'pending')`;
    });

    it("lists the caller's own posts across tenants, newest first, without deleted or held ones", async () => {
      const rows = await as(
        app,
        asUser(USER),
        (tx) => tx<{ id: string; tenant_id: string }[]>`
        select * from public.my_post_refs(null, null, null, 10)`,
      );
      expect(rows.map((r) => r.id)).toEqual([POST_B_PENDING, POST_A_DRAFT, POST_A_LIVE]);
      expect(rows[0]!.tenant_id).toBe(TENANT_B);
    });

    it('filters by status and pages by id', async () => {
      const live = await as(
        app,
        asUser(USER),
        (tx) => tx<{ id: string }[]>`
        select id from public.my_post_refs(array['live']::text[], null, null, 10)`,
      );
      expect(live.map((r) => r.id)).toEqual([POST_A_LIVE]);
      const page2 = await as(
        app,
        asUser(USER),
        (tx) => tx<{ id: string }[]>`
        select id from public.my_post_refs(null, null, ${POST_A_DRAFT}::uuid, 10)`,
      );
      expect(page2.map((r) => r.id)).toEqual([POST_A_LIVE]);
    });

    it('counts active posts (pending + live) and recent creations across tenants', async () => {
      const [stats] = await as(
        app,
        asUser(USER),
        (tx) => tx<{ active_count: number; created_since_count: number }[]>`
        select * from public.my_post_stats(now() - interval '1 day')`,
      );
      // live A + pending B (the deleted live one and the draft don't count as active).
      expect(stats!.active_count).toBe(2);
      expect(stats!.created_since_count).toBe(5);
    });

    it('filters the hidden tab (0029): hidden only, or none of them', async () => {
      await admin`update posts set hidden_by_owner = true where id = ${POST_A_LIVE}`;
      try {
        const hidden = await as(
          app,
          asUser(USER),
          (tx) => tx<{ id: string }[]>`select id from public.my_post_refs(null, true, null, 10)`,
        );
        expect(hidden.map((r) => r.id)).toEqual([POST_A_LIVE]);
        const shown = await as(
          app,
          asUser(USER),
          (tx) => tx<{ id: string }[]>`select id from public.my_post_refs(null, false, null, 10)`,
        );
        expect(shown.map((r) => r.id)).toEqual([POST_B_PENDING, POST_A_DRAFT]);

        const counts = await as(
          app,
          asUser(USER),
          (tx) => tx<{ bucket: string; post_count: number }[]>`
            select bucket, post_count from public.my_post_counts() order by bucket`,
        );
        // Hidden counts under hidden whatever its status; deleted posts not at all.
        expect(counts).toEqual([
          { bucket: 'draft', post_count: 1 },
          { bucket: 'hidden', post_count: 1 },
          { bucket: 'pending', post_count: 1 },
        ]);
      } finally {
        await admin`update posts set hidden_by_owner = false where id = ${POST_A_LIVE}`;
      }
    });

    it('shows a stranger nothing', async () => {
      const rows = await as(
        app,
        asUser(STRANGER),
        (tx) => tx`select * from public.my_post_refs(null, null, null, 10)`,
      );
      expect(rows).toHaveLength(0);
      const counts = await as(
        app,
        asUser(STRANGER),
        (tx) => tx`select * from public.my_post_counts()`,
      );
      expect(counts).toHaveLength(0);
    });
  });
});

import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0031 (ADR 036), called as ae_app exactly as the API does:
 * post_short_links' RLS (cross-tenant isolation, who may mint a code),
 * resolve_short_link, add_post_views, post_seller_card (no score leaks),
 * post_engagement_counts (owner and staff only) and report_post's auto-hide
 * at the threshold.
 */

const FIXTURE = '0191e3a0-e6a0-7000-8000-%';
const PARTNER = '0191e3a0-e6a0-7000-8000-000000000001';
const AREA_A = '0191e3a0-e6a0-7000-8000-000000000011';
const AREA_B = '0191e3a0-e6a0-7000-8000-000000000012';
const TENANT_A = '0191e3a0-e6a0-7000-8000-000000000021';
const TENANT_B = '0191e3a0-e6a0-7000-8000-000000000022';
const AUTHOR = '0191e3a0-e6a0-7000-8000-000000000031';
const R1 = '0191e3a0-e6a0-7000-8000-000000000032';
const R2 = '0191e3a0-e6a0-7000-8000-000000000033';
const R3 = '0191e3a0-e6a0-7000-8000-000000000034';
const OTHER_B = '0191e3a0-e6a0-7000-8000-000000000035';
const M_AUTHOR = '0191e3a0-e6a0-7000-8000-000000000041';
const M_R1 = '0191e3a0-e6a0-7000-8000-000000000042';
const M_R2 = '0191e3a0-e6a0-7000-8000-000000000043';
const M_R3 = '0191e3a0-e6a0-7000-8000-000000000044';
const M_OTHER_B = '0191e3a0-e6a0-7000-8000-000000000045';
const CATEGORY = '0191e3a0-e6a0-7000-8000-000000000051';
const SCHEMA = '0191e3a0-e6a0-7000-8000-000000000061';
const STORE = '0191e3a0-e6a0-7000-8000-000000000071';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 23.0,${east} 23.0,${east} 23.1,${west} 23.1,${west} 23.0)))`;
const POINT = 'SRID=4326;POINT(89.05 23.05)';

type Context = Record<string, string>;
const member = (tenant: string, user: string, memberId: string): Context => ({
  tenant_id: tenant,
  user_id: user,
  member_id: memberId,
  role: 'member',
});
const AS_AUTHOR = member(TENANT_A, AUTHOR, M_AUTHOR);
const AS_VISITOR_A: Context = { tenant_id: TENANT_A, role: 'anon' };
const AS_VISITOR_B: Context = { tenant_id: TENANT_B, role: 'anon' };
const AS_STAFF_A: Context = { tenant_id: TENANT_A, role: 'moderator' };
const AS_SYSTEM: Context = { role: 'system' };

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

let nextPost = 0x1000;
const newPostId = () => `0191e3a0-e6a0-7000-8000-${(nextPost++).toString(16).padStart(12, '0')}`;

describe('Post engagement (0031)', () => {
  let admin: Sql;
  let app: Sql;

  const post = async (
    extra: { status?: string; tenant?: string; author?: string; hidden?: boolean } = {},
  ): Promise<string> => {
    const id = newPostId();
    const status = extra.status ?? 'live';
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
         published_at, sold_at, location, hidden_by_owner, contact_phone_e164)
      values
        (${id}, ${extra.tenant ?? TENANT_A}, ${extra.author ?? M_AUTHOR}, ${CATEGORY}, ${SCHEMA},
         'engagement post', ${status}, ${status === 'live' || status === 'sold' ? new Date() : null},
         ${status === 'sold' ? new Date() : null}, ${POINT}, ${extra.hidden ?? false}, '+8801755000001')`;
    return id;
  };

  const report = (context: Context, postId: string, reason = 'scam') =>
    as(
      app,
      context,
      (tx) => tx<
        { report_id: string; created: boolean; reporter_count: number; auto_hidden: boolean }[]
      >`
        select * from public.report_post(${postId}, ${reason}, 'fixture report')`,
    ).then((rows) => rows[0]!);

  async function clearPosts(): Promise<void> {
    await admin.begin(async (tx) => {
      // moderation_actions is append-only (trigger); teardown bypasses it.
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from moderation_queue_items where tenant_id::text like ${FIXTURE}`;
    await admin`delete from reports where tenant_id::text like ${FIXTURE}`;
    await admin`delete from lead_events where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from post_short_links where tenant_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_table = 'posts' and aggregate_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`update tenant_settings set setting_overrides = '{}' where tenant_id::text like ${FIXTURE}`;
  }

  async function cleanUp(): Promise<void> {
    await clearPosts();
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164, phone_verified_at) values
        (${AUTHOR}, '+8801755000001', now()), (${R1}, '+8801755000002', now()),
        (${R2}, '+8801755000003', now()), (${R3}, '+8801755000004', now()),
        (${OTHER_B}, '+8801755000005', now())`;
    await admin`insert into user_profiles (user_id, display_name) values (${AUTHOR}, 'করিম সাহেব')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Engagement Partner', 'Engagement Partner', '+8801755000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'eng-a', 'Engagement A', 'fixture', ${square(89.0, 89.1)}, ${square(89.0, 89.1)}),
        (${AREA_B}, 3, 'upazila', 'eng-b', 'Engagement B', 'fixture', ${square(89.1, 89.2)}, ${square(89.1, 89.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'eng-a', 'এ', 'A', 'SRID=4326;POINT(89.05 23.05)', 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'eng-b', 'বি', 'B', 'SRID=4326;POINT(89.15 23.05)', 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_AUTHOR}, ${TENANT_A}, ${AUTHOR}, 'member'), (${M_R1}, ${TENANT_A}, ${R1}, 'member'),
        (${M_R2}, ${TENANT_A}, ${R2}, 'member'), (${M_R3}, ${TENANT_A}, ${R3}, 'member'),
        (${M_OTHER_B}, ${TENANT_B}, ${OTHER_B}, 'member')`;
    await admin`
      insert into member_trust_scores (tenant_id, member_id, score, components, algorithm_version)
      values (${TENANT_A}, ${M_AUTHOR}, 72, '{}', 1)`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'engagement-category', 'বিভাগ', 'Category')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin.begin(async (tx) => {
      // Only staff or the system may set a store's status (stores_protect_status, 0006).
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, is_verified)
        values (${STORE}, ${TENANT_A}, ${M_AUTHOR}, 'karim-store', 'করিম স্টোর', 'active', true)`;
    });
  }, 60_000);

  afterEach(clearPosts);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('post_short_links', () => {
    it("lets a visitor mint a live post's code, never a draft's", async () => {
      const live = await post();
      const draft = await post({ status: 'draft' });
      await as(
        app,
        AS_VISITOR_A,
        (tx) => tx`insert into post_short_links (post_id, code) values (${live}, 'livecode1')`,
      );
      await expect(
        as(
          app,
          AS_VISITOR_A,
          (tx) => tx`insert into post_short_links (post_id, code) values (${draft}, 'draftcode')`,
        ),
      ).rejects.toThrow(/row-level security/);
      // The author may share their own draft's code (they can see it).
      await as(
        app,
        AS_AUTHOR,
        (tx) => tx`insert into post_short_links (post_id, code) values (${draft}, 'draftcode')`,
      );
    });

    it('keeps one code per post and every code unique across tenants', async () => {
      const a = await post();
      const b = await post({ tenant: TENANT_B, author: M_OTHER_B });
      await as(
        app,
        AS_VISITOR_A,
        (tx) => tx`insert into post_short_links (post_id, code) values (${a}, 'samecode1')`,
      );
      await expect(
        as(
          app,
          AS_VISITOR_B,
          (tx) => tx`insert into post_short_links (post_id, code) values (${b}, 'samecode1')`,
        ),
      ).rejects.toThrow(/post_short_links_code_uq/);
      await expect(
        as(
          app,
          AS_VISITOR_A,
          (tx) => tx`insert into post_short_links (post_id, code) values (${a}, 'second01')`,
        ),
      ).rejects.toThrow(/post_short_links_tenant_post_uq/);
    });

    it("isolates tenants: B can't read A's codes or mint one for A's post", async () => {
      const a = await post();
      await as(
        app,
        AS_VISITOR_A,
        (tx) => tx`insert into post_short_links (post_id, code) values (${a}, 'tenanta01')`,
      );
      const seenByB = await as(
        app,
        AS_VISITOR_B,
        (tx) => tx`select code from post_short_links where post_id = ${a}`,
      );
      expect(seenByB).toHaveLength(0);
      await expect(
        as(
          app,
          AS_VISITOR_B,
          (tx) =>
            tx`insert into post_short_links (tenant_id, post_id, code) values (${TENANT_A}, ${a}, 'intruder1')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('resolves a code with no tenant context, ids only', async () => {
      const a = await post();
      await as(
        app,
        AS_VISITOR_A,
        (tx) => tx`insert into post_short_links (post_id, code) values (${a}, 'resolve01')`,
      );
      const rows = await as(
        app,
        { role: 'anon' },
        (tx) => tx`select * from public.resolve_short_link('resolve01')`,
      );
      expect(rows).toEqual([{ tenant_id: TENANT_A, post_id: a }]);
      const none = await as(
        app,
        { role: 'anon' },
        (tx) => tx`select * from public.resolve_short_link('missing01')`,
      );
      expect(none).toHaveLength(0);
    });
  });

  describe('add_post_views', () => {
    it('adds batched counts (summing repeats) for the system only', async () => {
      const a = await post();
      const b = await post({ tenant: TENANT_B, author: M_OTHER_B });
      const [row] = await as(
        app,
        AS_SYSTEM,
        (tx) => tx<{ updated: number }[]>`
          select public.add_post_views(array[${a}, ${b}, ${a}]::uuid[], array[3, 2, 1]::integer[]) as updated`,
      );
      expect(row!.updated).toBe(2);
      const counts = await admin<{ id: string; view_count: number }[]>`
        select id, view_count from posts where id in (${a}, ${b})`;
      expect(Object.fromEntries(counts.map((r) => [r.id, r.view_count]))).toEqual({
        [a]: 4,
        [b]: 2,
      });

      await expect(
        as(
          app,
          AS_AUTHOR,
          (tx) => tx`select public.add_post_views(array[${a}]::uuid[], array[5]::integer[])`,
        ),
      ).rejects.toThrow(/system only/);
    });
  });

  describe('post_seller_card', () => {
    type Card = Record<string, unknown>;
    const card = (context: Context, postId: string, trustedMin = 60) =>
      as(
        app,
        context,
        (tx) =>
          tx<Card[]>`select * from public.post_seller_card(${postId}, ${trustedMin}::smallint)`,
      );

    it('tells a visitor the name, badges and store, never the trust score', async () => {
      const live = await post();
      const [row] = await card(AS_VISITOR_A, live);
      expect(row).toMatchObject({
        display_name: 'করিম সাহেব',
        phone_verified: true,
        trusted: true,
        store_slug: 'karim-store',
        store_verified: true,
      });
      expect(Object.keys(row!)).not.toContain('score');
      expect(Object.values(row!)).not.toContain(72);
      expect((await card(AS_VISITOR_A, live, 80))[0]).toMatchObject({ trusted: false });
    });

    it('answers nothing for a post the caller may not see, or from another tenant', async () => {
      const draft = await post({ status: 'draft' });
      const hidden = await post({ hidden: true });
      expect(await card(AS_VISITOR_A, draft)).toHaveLength(0);
      expect(await card(AS_VISITOR_A, hidden)).toHaveLength(0);
      expect(await card(AS_AUTHOR, draft)).toHaveLength(1);
      expect(await card(AS_STAFF_A, hidden)).toHaveLength(1);
      const live = await post();
      expect(await card(AS_VISITOR_B, live)).toHaveLength(0);
    });
  });

  describe('post_engagement_counts', () => {
    it('counts views, contacts by channel and saves for the author and staff only', async () => {
      const live = await post();
      await admin`update posts set view_count = 9 where id = ${live}`;
      await admin`
        insert into lead_events (tenant_id, channel_code, source_code, post_id, target_member_id, anon_session_hash) values
          (${TENANT_A}, 'call_click', 'post_detail', ${live}, ${M_AUTHOR}, 'k1'),
          (${TENANT_A}, 'call_click', 'post_detail', ${live}, ${M_AUTHOR}, 'k2'),
          (${TENANT_A}, 'whatsapp_click', 'post_detail', ${live}, ${M_AUTHOR}, 'k1')`;
      await admin`insert into saved_posts (tenant_id, user_id, post_id) values (${TENANT_A}, ${R1}, ${live})`;

      const counts = (context: Context) =>
        as(app, context, (tx) => tx`select * from public.post_engagement_counts(${live})`);
      expect(await counts(AS_AUTHOR)).toEqual([
        { views: 9, calls: 2, whatsapp: 1, sms: 0, saves: 1 },
      ]);
      expect(await counts(AS_STAFF_A)).toHaveLength(1);
      expect(await counts(member(TENANT_A, R1, M_R1))).toHaveLength(0);
      expect(await counts(AS_VISITOR_A)).toHaveLength(0);
      expect(await counts(member(TENANT_B, OTHER_B, M_OTHER_B))).toHaveLength(0);
    });
  });

  describe('report_post', () => {
    const status = async (id: string) =>
      (await admin<{ status_code: string }[]>`select status_code from posts where id = ${id}`)[0]!
        .status_code;

    it('auto-hides at the threshold of DISTINCT reporters, audited and queued in the same transaction', async () => {
      const live = await post();
      expect(await report(member(TENANT_A, R1, M_R1), live)).toMatchObject({
        created: true,
        reporter_count: 1,
        auto_hidden: false,
      });
      // The same reporter again: the open report comes back, nothing counts twice.
      expect(await report(member(TENANT_A, R1, M_R1), live, 'spam')).toMatchObject({
        created: false,
        reporter_count: 1,
        auto_hidden: false,
      });
      expect(await report(member(TENANT_A, R2, M_R2), live)).toMatchObject({
        reporter_count: 2,
        auto_hidden: false,
      });
      expect(await status(live)).toBe('live');

      expect(await report(member(TENANT_A, R3, M_R3), live)).toMatchObject({
        reporter_count: 3,
        auto_hidden: true,
      });
      expect(await status(live)).toBe('pending');

      const [action] = await admin<
        {
          action_code: string;
          reason_code: string;
          actor_user_id: string | null;
          evidence_refs: string[];
        }[]
      >`
        select action_code, reason_code, actor_user_id, evidence_refs from moderation_actions where post_id = ${live}`;
      expect(action).toMatchObject({
        action_code: 'auto_hidden',
        reason_code: 'community_reports',
        actor_user_id: null,
      });
      expect(action!.evidence_refs).toHaveLength(3);
      const items = await admin`
        select source_code, reasons, status_code from moderation_queue_items where post_id = ${live}`;
      expect(items).toEqual([
        { source_code: 'report', reasons: ['reported'], status_code: 'open' },
      ]);
      const [event] = await admin`
        select event_type from outbox_events where aggregate_id = ${live} and event_type = 'post.auto_hidden'`;
      expect(event).toBeDefined();
    });

    it("joins an open queue item's reasons instead of opening a second one", async () => {
      const live = await post();
      await as(
        app,
        AS_STAFF_A,
        (tx) => tx`select public.file_moderation_item(${live}, 'sample', array['sample'], null)`,
      );
      for (const [user, memberId] of [
        [R1, M_R1],
        [R2, M_R2],
        [R3, M_R3],
      ] as const) {
        await report(member(TENANT_A, user, memberId), live);
      }
      const items =
        await admin`select source_code, reasons from moderation_queue_items where post_id = ${live}`;
      expect(items).toEqual([{ source_code: 'sample', reasons: ['reported', 'sample'] }]);
    });

    it("follows the tenant's own threshold, and 0 turns auto-hide off", async () => {
      const live = await post();
      await admin`update tenant_settings set setting_overrides = '{"auto_hide_report_threshold": 1}' where tenant_id = ${TENANT_A}`;
      expect(await report(member(TENANT_A, R1, M_R1), live)).toMatchObject({ auto_hidden: true });

      const other = await post();
      await admin`update tenant_settings set setting_overrides = '{"auto_hide_report_threshold": 0}' where tenant_id = ${TENANT_A}`;
      for (const [user, memberId] of [
        [R1, M_R1],
        [R2, M_R2],
        [R3, M_R3],
      ] as const) {
        expect(await report(member(TENANT_A, user, memberId), other)).toMatchObject({
          auto_hidden: false,
        });
      }
      expect(await status(other)).toBe('live');
    });

    it('refuses the author, a non-public post, a guest and another tenant', async () => {
      const live = await post();
      await expect(report(AS_AUTHOR, live)).rejects.toMatchObject({ code: 'AE201' });
      const draft = await post({ status: 'draft' });
      await expect(report(member(TENANT_A, R1, M_R1), draft)).rejects.toMatchObject({
        code: 'P0002',
      });
      await expect(report(AS_VISITOR_A, live)).rejects.toMatchObject({ code: '42501' });
      await expect(report(member(TENANT_B, OTHER_B, M_OTHER_B), live)).rejects.toMatchObject({
        code: 'P0002',
      });
    });

    it('never hides a sold post (it is out of the feed already)', async () => {
      const sold = await post({ status: 'sold' });
      await admin`update tenant_settings set setting_overrides = '{"auto_hide_report_threshold": 1}' where tenant_id = ${TENANT_A}`;
      expect(await report(member(TENANT_A, R1, M_R1), sold)).toMatchObject({
        created: true,
        auto_hidden: false,
      });
      expect(await status(sold)).toBe('sold');
    });
  });
});

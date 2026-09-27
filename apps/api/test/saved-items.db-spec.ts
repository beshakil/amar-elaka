import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0032 (ADR 037), as ae_app: saved_places/saved_stores RLS (own
 * rows across tenants, nobody else's, only visible targets), the counter
 * triggers (and that they never reindex), my_saved_items' states (a saved
 * post never disappears, even when scrubbed), and tenant_store_activity.
 */

const FIXTURE = '0191e3a0-5a0e-7000-8000-%';
const PARTNER = '0191e3a0-5a0e-7000-8000-000000000001';
const AREA_A = '0191e3a0-5a0e-7000-8000-000000000011';
const AREA_B = '0191e3a0-5a0e-7000-8000-000000000012';
const TENANT_A = '0191e3a0-5a0e-7000-8000-000000000021';
const TENANT_B = '0191e3a0-5a0e-7000-8000-000000000022';
const SELLER = '0191e3a0-5a0e-7000-8000-000000000031';
const SAVER = '0191e3a0-5a0e-7000-8000-000000000032';
const OTHER = '0191e3a0-5a0e-7000-8000-000000000033';
const MOD = '0191e3a0-5a0e-7000-8000-000000000034';
const M_SELLER = '0191e3a0-5a0e-7000-8000-000000000041';
const M_SAVER = '0191e3a0-5a0e-7000-8000-000000000042';
const M_MOD = '0191e3a0-5a0e-7000-8000-000000000044';
const M_SELLER_B = '0191e3a0-5a0e-7000-8000-000000000045';
const CATEGORY = '0191e3a0-5a0e-7000-8000-000000000051';
const PLACE_CATEGORY = '0191e3a0-5a0e-7000-8000-000000000052';
const SCHEMA = '0191e3a0-5a0e-7000-8000-000000000061';
const STORE_ACTIVE = '0191e3a0-5a0e-7000-8000-000000000071';
const STORE_QUIET = '0191e3a0-5a0e-7000-8000-000000000072';
const STORE_SUSPENDED = '0191e3a0-5a0e-7000-8000-000000000073';
const PLACE_OPEN = '0191e3a0-5a0e-7000-8000-000000000081';
const PLACE_PENDING = '0191e3a0-5a0e-7000-8000-000000000082';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 22.0,${east} 22.0,${east} 22.1,${west} 22.1,${west} 22.0)))`;
const POINT = 'SRID=4326;POINT(88.05 22.05)';

type Context = Record<string, string>;
const saverIn = (tenant: string): Context => ({
  tenant_id: tenant,
  user_id: SAVER,
  role: 'anon',
  ...(tenant === TENANT_A ? { member_id: M_SAVER, role: 'member' } : {}),
});
const AS_OTHER_A: Context = { tenant_id: TENANT_A, user_id: OTHER, role: 'anon' };

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

let next = 0x1000;
const newId = () => `0191e3a0-5a0e-7000-8000-${(next++).toString(16).padStart(12, '0')}`;

interface SavedRow {
  item_type: string;
  item_id: string;
  state: string;
  name_bn: string | null;
  price: string | null;
}

describe('Saved items and follows (0032)', () => {
  let admin: Sql;
  let app: Sql;

  const post = async (
    extra: {
      status?: string;
      tenant?: string;
      member?: string;
      hidden?: boolean;
      deleted?: boolean;
      storeId?: string;
      publishedAt?: Date;
    } = {},
  ): Promise<string> => {
    const id = newId();
    const status = extra.status ?? 'live';
    const published = ['live', 'sold', 'expired'].includes(status)
      ? (extra.publishedAt ?? new Date())
      : null;
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title, fields, status_code,
         published_at, sold_at, location, hidden_by_owner, deleted_at, deletion_reason_code)
      values
        (${id}, ${extra.tenant ?? TENANT_A}, ${extra.member ?? M_SELLER}, ${extra.storeId ?? null}, ${CATEGORY},
         ${SCHEMA}, ${`সেভ পোস্ট ${id.slice(-4)}`}, ${admin.json({ price: '5000.00' })}, ${status},
         ${published}, ${status === 'sold' ? new Date() : null}, ${POINT}, ${extra.hidden ?? false},
         ${extra.deleted ? new Date() : null}, ${extra.deleted ? 'user_deleted' : null})`;
    return id;
  };

  const savePost = (context: Context, postId: string) =>
    as(
      app,
      context,
      (tx) => tx`insert into saved_posts (post_id, user_id) values (${postId}, ${SAVER})`,
    );

  const mySaved = (
    context: Context,
    type: string | null = null,
    before: string | null = null,
    limit = 50,
  ) =>
    as(
      app,
      context,
      (tx) => tx<(SavedRow & { save_id: string })[]>`
        select save_id, item_type, item_id, state, name_bn, price
        from public.my_saved_items(${type}, ${before}::uuid, ${limit})`,
    );

  async function clearSaves(): Promise<void> {
    await admin`delete from saved_posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from store_follows where tenant_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
  }

  async function cleanUp(): Promise<void> {
    await clearSaves();
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${SELLER}, '+8801733000001'), (${SAVER}, '+8801733000002'),
        (${OTHER}, '+8801733000003'), (${MOD}, '+8801733000004')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Saved Partner', 'Saved Partner', '+8801733000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'saved-a', 'Saved A', 'fixture', ${square(88.0, 88.1)}, ${square(88.0, 88.1)}),
        (${AREA_B}, 3, 'upazila', 'saved-b', 'Saved B', 'fixture', ${square(88.1, 88.2)}, ${square(88.1, 88.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'saved-a', 'এ', 'A', ${POINT}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'saved-b', 'বি', 'B', 'SRID=4326;POINT(88.15 22.05)', 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_SELLER}, ${TENANT_A}, ${SELLER}, 'member'), (${M_SAVER}, ${TENANT_A}, ${SAVER}, 'member'),
        (${M_MOD}, ${TENANT_A}, ${MOD}, 'moderator'), (${M_SELLER_B}, ${TENANT_B}, ${SELLER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'saved-category', 'বিভাগ', 'Category'),
        (${PLACE_CATEGORY}, 'place', 'saved-place-category', 'জায়গা', 'Place')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin.begin(async (tx) => {
      // Store status is staff/system-only (stores_protect_status, 0006).
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, created_at) values
          (${STORE_ACTIVE}, ${TENANT_A}, ${M_SELLER}, 'saved-active', 'সক্রিয় দোকান', 'active', now() - interval '90 days'),
          (${STORE_QUIET}, ${TENANT_A}, ${M_SELLER}, 'saved-quiet', 'চুপচাপ দোকান', 'active', now() - interval '90 days'),
          (${STORE_SUSPENDED}, ${TENANT_A}, ${M_SELLER}, 'saved-suspended', 'স্থগিত দোকান', 'suspended', now() - interval '90 days')`;
    });
    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, status_code, location, source_code) values
        (${PLACE_OPEN}, ${TENANT_A}, ${PLACE_CATEGORY}, 'saved-open', 'খোলা জায়গা', 'published', ${POINT}, 'agent_survey'),
        (${PLACE_PENDING}, ${TENANT_A}, ${PLACE_CATEGORY}, 'saved-pending', 'অপেক্ষমাণ জায়গা', 'pending_review', ${POINT}, 'agent_survey')`;
  }, 60_000);

  afterEach(clearSaves);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('RLS', () => {
    it("shows a user their own saves from any tenant, and nobody else's", async () => {
      const inB = await post({ tenant: TENANT_B, member: M_SELLER_B });
      await savePost(saverIn(TENANT_B), inB);
      await as(
        app,
        saverIn(TENANT_A),
        (tx) => tx`insert into saved_places (place_id, user_id) values (${PLACE_OPEN}, ${SAVER})`,
      );
      await as(
        app,
        saverIn(TENANT_A),
        (tx) => tx`insert into saved_stores (store_id, user_id) values (${STORE_ACTIVE}, ${SAVER})`,
      );

      // From tenant A's context the saver still sees the B post's save.
      const fromA = await as(
        app,
        saverIn(TENANT_A),
        (tx) => tx<{ post_id: string }[]>`select post_id from saved_posts`,
      );
      expect(fromA.map((r) => r.post_id)).toContain(inB);
      for (const table of ['saved_places', 'saved_stores'] as const) {
        const own = await as(app, saverIn(TENANT_B), (tx) => tx`select id from ${tx(table)}`);
        expect(own).toHaveLength(1);
        const others = await as(app, AS_OTHER_A, (tx) => tx`select id from ${tx(table)}`);
        expect(others).toHaveLength(0);
      }
    });

    it("saves only what the saver can see, only as themselves, only in the target's tenant", async () => {
      await expect(
        as(
          app,
          AS_OTHER_A,
          (tx) =>
            tx`insert into saved_places (place_id, user_id) values (${PLACE_PENDING}, ${OTHER})`,
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        as(
          app,
          AS_OTHER_A,
          (tx) =>
            tx`insert into saved_stores (store_id, user_id) values (${STORE_SUSPENDED}, ${OTHER})`,
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        as(
          app,
          AS_OTHER_A,
          (tx) =>
            tx`insert into saved_stores (store_id, user_id) values (${STORE_ACTIVE}, ${SAVER})`,
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        as(
          app,
          { tenant_id: TENANT_B, user_id: OTHER, role: 'anon' },
          (tx) =>
            tx`insert into saved_stores (tenant_id, store_id, user_id) values (${TENANT_A}, ${STORE_ACTIVE}, ${OTHER})`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('counters', () => {
    it('keeps posts.saved_count and stores.follower_count, without reindexing either', async () => {
      const id = await post();
      await admin`update posts set search_synced_at = now() + interval '1 minute' where id = ${id}`;
      await admin`update stores set search_synced_at = now() + interval '1 minute' where id = ${STORE_ACTIVE}`;
      const syncEvents = () =>
        admin<{ n: number }[]>`
          select count(*)::int as n from outbox_events
          where event_type = 'search.sync' and aggregate_id in (${id}, ${STORE_ACTIVE})`.then(
          (r) => r[0]!.n,
        );
      const before = await syncEvents();

      await savePost(saverIn(TENANT_A), id);
      await as(
        app,
        AS_OTHER_A,
        (tx) => tx`insert into saved_posts (post_id, user_id) values (${id}, ${OTHER})`,
      );
      await as(
        app,
        saverIn(TENANT_A),
        (tx) =>
          tx`insert into store_follows (store_id, user_id) values (${STORE_ACTIVE}, ${SAVER})`,
      );
      const counts = async () =>
        (
          await admin<
            { saved: number; followers: number; post_fresh: boolean; store_fresh: boolean }[]
          >`
            select p.saved_count as saved, s.follower_count as followers,
                   p.search_synced_at >= p.updated_at as post_fresh, s.search_synced_at >= s.updated_at as store_fresh
            from posts p, stores s where p.id = ${id} and s.id = ${STORE_ACTIVE}`
        )[0]!;
      expect(await counts()).toEqual({
        saved: 2,
        followers: 1,
        post_fresh: true,
        store_fresh: true,
      });

      await as(app, AS_OTHER_A, (tx) => tx`delete from saved_posts where post_id = ${id}`);
      await as(
        app,
        saverIn(TENANT_B),
        (tx) => tx`delete from store_follows where store_id = ${STORE_ACTIVE}`,
      );
      expect(await counts()).toMatchObject({ saved: 1, followers: 0 });
      expect(await syncEvents()).toBe(before);
    });
  });

  describe('my_saved_items', () => {
    it('keeps every saved post, each with what became of it', async () => {
      const live = await post();
      const sold = await post({ status: 'sold' });
      const expired = await post({ status: 'expired' });
      const hidden = await post({ hidden: true });
      const deleted = await post({ deleted: true });
      const removed = await post();
      for (const id of [live, sold, expired, hidden, deleted, removed]) {
        await savePost(saverIn(TENANT_A), id);
      }
      await admin`update posts set status_code = 'removed', moderation_reason_code = 'spam' where id = ${removed}`;

      const rows = await mySaved(saverIn(TENANT_B), 'post');
      const byId = new Map(rows.map((r) => [r.item_id, r]));
      expect(rows).toHaveLength(6);
      expect(byId.get(live)).toMatchObject({ state: 'available', price: '5000.00' });
      expect(byId.get(sold)).toMatchObject({ state: 'sold', price: '5000.00' });
      expect(byId.get(expired)).toMatchObject({ state: 'expired', price: '5000.00' });
      expect(byId.get(hidden)).toMatchObject({ state: 'unavailable', price: null });
      expect(byId.get(hidden)!.name_bn).not.toBeNull();
      expect(byId.get(deleted)).toMatchObject({ state: 'deleted', price: null });
      expect(byId.get(removed)).toMatchObject({ state: 'removed', name_bn: null, price: null });
    });

    it('keeps a save when a moderator scrubs the post, and shows nothing of it', async () => {
      const id = await post();
      await savePost(saverIn(TENANT_A), id);
      await admin.begin(async (tx) => {
        await tx`
          insert into moderation_actions (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
          values (${TENANT_A}, ${id}, ${MOD}, 'moderator_removed', 'spam', 'fixture', '["ev-1"]')`;
        await tx`select public.scrub_post(${id}, 'spam', 'moderator_removed')`;
      });
      const [row] = await mySaved(saverIn(TENANT_A), 'post');
      expect(row).toMatchObject({ item_id: id, state: 'removed', name_bn: null, price: null });
    });

    it('mixes posts, places and stores newest first, paged by cursor and filtered by type', async () => {
      const first = await post();
      await savePost(saverIn(TENANT_A), first);
      await as(
        app,
        saverIn(TENANT_A),
        (tx) => tx`insert into saved_places (place_id, user_id) values (${PLACE_OPEN}, ${SAVER})`,
      );
      await as(
        app,
        saverIn(TENANT_A),
        (tx) => tx`insert into saved_stores (store_id, user_id) values (${STORE_ACTIVE}, ${SAVER})`,
      );

      const all = await mySaved(saverIn(TENANT_A));
      expect(all.map((r) => r.item_type)).toEqual(['store', 'place', 'post']);
      expect(all[0]).toMatchObject({ state: 'available', name_bn: 'সক্রিয় দোকান' });
      const page2 = await mySaved(saverIn(TENANT_A), null, all[0]!.save_id, 1);
      expect(page2.map((r) => r.item_type)).toEqual(['place']);
      expect((await mySaved(saverIn(TENANT_A), 'place')).map((r) => r.item_id)).toEqual([
        PLACE_OPEN,
      ]);

      // A place that closes stays, marked closed.
      await admin`update places set status_code = 'permanently_closed' where id = ${PLACE_OPEN}`;
      expect((await mySaved(saverIn(TENANT_A), 'place'))[0]).toMatchObject({ state: 'closed' });
      await admin`update places set status_code = 'published' where id = ${PLACE_OPEN}`;
      // Nobody else sees the saver's list.
      expect(await mySaved(AS_OTHER_A)).toHaveLength(0);
    });
  });

  describe('tenant_store_activity', () => {
    it('averages posts per active store per month (suspended stores left out)', async () => {
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 10);
      for (let i = 0; i < 3; i++) await post({ storeId: STORE_ACTIVE });
      await post({ storeId: STORE_ACTIVE, publishedAt: lastMonth });
      await post({ storeId: STORE_SUSPENDED });

      const rows = await as(
        app,
        { tenant_id: TENANT_A, role: 'tenant_admin' },
        (tx) => tx`select * from public.tenant_store_activity(2)`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        active_stores: 2,
        posting_stores: 1,
        store_posts: 3,
        avg_posts_per_active_store: '1.50',
        avg_posts_per_posting_store: '3.00',
      });
      expect(rows[1]).toMatchObject({ active_stores: 2, posting_stores: 1, store_posts: 1 });
      expect(new Date(rows[0]!.month as string) > new Date(rows[1]!.month as string)).toBe(true);
    });

    it('is for tenant admins, marketers and platform staff only, and clamps the months', async () => {
      const call = (context: Context, months = 3) =>
        as(app, context, (tx) => tx`select * from public.tenant_store_activity(${months})`);
      await expect(
        call({ tenant_id: TENANT_A, role: 'member', user_id: SAVER }),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(call({ tenant_id: TENANT_A, role: 'moderator' })).rejects.toMatchObject({
        code: '42501',
      });
      expect(await call({ tenant_id: TENANT_A, role: 'marketer' })).toHaveLength(3);
      expect(await call({ tenant_id: TENANT_A, role: 'tenant_admin' }, 999)).toHaveLength(24);
    });
  });
});

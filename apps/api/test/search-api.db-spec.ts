import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0034 (ADR 040): the search query log and what is built on it.
 *
 *  - search_queries RLS: a searcher logs as themselves or anonymously, in
 *    their own tenant only; nobody outside the tenant's admins (and platform)
 *    reads rows, and never another tenant's.
 *  - record_search_click: the searcher's own recent search, once, only for a
 *    public post.
 *  - search_popular_queries: aggregates of the current tenant, counted in
 *    distinct searchers, so one person can't make a query trend.
 *  - a scrubbed post is forgotten by the log.
 *  - the boost slot cap re-syncs a boosted post's category, and the cap
 *    changing re-syncs every boosted post.
 *
 * Setup runs as the superuser; everything under test runs as ae_app with
 * the application's session settings.
 */

const PARTNER = '0191e3a0-5ea4-7000-8000-000000000001';
const AREA_A = '0191e3a0-5ea4-7000-8000-000000000011';
const AREA_B = '0191e3a0-5ea4-7000-8000-000000000012';
const TENANT_A = '0191e3a0-5ea4-7000-8000-000000000021';
const TENANT_B = '0191e3a0-5ea4-7000-8000-000000000022';
const USER_1 = '0191e3a0-5ea4-7000-8000-000000000031';
const USER_2 = '0191e3a0-5ea4-7000-8000-000000000032';
const MEMBER_1 = '0191e3a0-5ea4-7000-8000-000000000041';
const CATEGORY = '0191e3a0-5ea4-7000-8000-000000000051';
const SCHEMA = '0191e3a0-5ea4-7000-8000-000000000061';
const POST = '0191e3a0-5ea4-7000-8000-000000000071';
const POST_SCRUBBED = '0191e3a0-5ea4-7000-8000-000000000072';
const FIXTURE = '0191e3a0-5ea4-7000-8000-%';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const FILTERS = '0123456789abcdef';

type Context = Record<string, string>;
const anon = (tenant: string): Context => ({ tenant_id: tenant, role: 'anon' });
const member = (tenant: string, user: string): Context => ({
  tenant_id: tenant,
  user_id: user,
  role: 'member',
});
const tenantAdmin = (tenant: string): Context => ({
  tenant_id: tenant,
  user_id: USER_2,
  role: 'tenant_admin',
});
const moderator = (tenant: string): Context => ({ tenant_id: tenant, role: 'moderator' });
const SYSTEM: Context = { role: 'system', is_platform_admin: 'true' };

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

describe('Search query log, clicks, trending and the boost cap (0034)', () => {
  let admin: Sql;
  let app: Sql;

  /** Logs a search as ae_app in `context`; returns its id. */
  const log = async (
    context: Context,
    q: string,
    searcher: number,
    extra: { resultCount?: number; userId?: string | null; tenantId?: string } = {},
  ) =>
    as(app, context, async (tx) => {
      // As SearchQueryRepository.logQuery: no RETURNING, the searcher can't read the log.
      const [row] = await tx<{ id: string }[]>`select uuid_generate_v7()::text as id`;
      await tx`
        insert into search_queries (id, tenant_id, user_id, searcher_hash, q_normalized, filters_hash, result_count)
        values (${row!.id}, ${extra.tenantId ?? context.tenant_id!}, ${extra.userId ?? null},
                ${hash(searcher)}, ${q}, ${FILTERS}, ${extra.resultCount ?? 3})`;
      return row!.id;
    });

  const click = (context: Context, searchId: string, postId: string, windowMinutes = 60) =>
    as(app, context, async (tx) => {
      const [row] = await tx<{ recorded: boolean }[]>`
        select record_search_click(${searchId}, ${postId}, ${windowMinutes}) as recorded`;
      return row!.recorded;
    });

  const popular = (context: Context, minSearchers: number) =>
    as(
      app,
      context,
      (tx) =>
        tx<{ q_normalized: string; searchers: string; searches: string }[]>`
        select q_normalized, searchers, searches
        from search_popular_queries(now() - interval '1 day', ${minSearchers}, 10)`,
    );

  const resyncEvents = () =>
    admin<{ aggregate_table: string; payload: Record<string, unknown> }[]>`
      select aggregate_table, payload from outbox_events
      where event_type = 'search.resync'
        and (payload::text like ${`%${TENANT_A}%`} or payload->>'scope' = 'boosted'
             or aggregate_id::text like ${FIXTURE})
      order by occurred_at, id`;
  const clearEvents = () =>
    admin`
      delete from outbox_events
      where event_type like 'search.%'
        and (aggregate_id::text like ${FIXTURE} or payload::text like ${`%${TENANT_A}%`}
             or payload->>'scope' = 'boosted')`;

  async function cleanUp(): Promise<void> {
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    // moderation_actions is append-only (a trigger); fixtures leave the replica way.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from boosts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
    await clearEvents();
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${USER_1}, '+8801766500301'), (${USER_2}, '+8801766500302')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Search API Partner', 'Search API Partner', '+8801766500399')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${AREA_A}, 3, 'upazila', 'search-api-a', 'Search API A', 'fixture'),
        (${AREA_B}, 3, 'upazila', 'search-api-b', 'Search API B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'search-api-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'search-api-b', 'বি', 'B', st_point(90.5, 23.8)::geography, 'active')`;
    await admin`
      insert into tenant_settings (tenant_id, setting_overrides) values
        (${TENANT_A}, '{}'::jsonb), (${TENANT_B}, '{}'::jsonb)`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code)
      values (${MEMBER_1}, ${TENANT_A}, ${USER_1}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'search-api-cat', 'ক', 'C')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, '{"type":"object"}', 'published', now())`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code, published_at)
      values
        (${POST}, ${TENANT_A}, ${MEMBER_1}, ${CATEGORY}, ${SCHEMA}, 'ডাক্তার', 'live', now()),
        (${POST_SCRUBBED}, ${TENANT_A}, ${MEMBER_1}, ${CATEGORY}, ${SCHEMA}, 'গোপন', 'live', now())`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  beforeEach(async () => {
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    await clearEvents();
  });

  describe('search_queries RLS', () => {
    it('logs as oneself or anonymously, never as someone else or with a click', async () => {
      await expect(log(anon(TENANT_A), 'daktar', 1)).resolves.toMatch(/^[0-9a-f-]{36}$/);
      await expect(
        log(member(TENANT_A, USER_1), 'daktar', 2, { userId: USER_1 }),
      ).resolves.toBeDefined();
      await expect(log(anon(TENANT_A), 'daktar', 3, { userId: USER_1 })).rejects.toThrow(
        /row-level security/,
      );
      await expect(log(member(TENANT_A, USER_1), 'daktar', 4, { userId: USER_2 })).rejects.toThrow(
        /row-level security/,
      );
      await expect(
        as(
          app,
          anon(TENANT_A),
          (tx) => tx`
            insert into search_queries
              (tenant_id, searcher_hash, q_normalized, filters_hash, result_count, clicked_post_id)
            values (${TENANT_A}, ${hash(5)}, 'x', ${FILTERS}, 1, ${POST})`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('blocks cross-tenant writes and reads', async () => {
      // Tenant A's context cannot log into tenant B.
      await expect(log(anon(TENANT_A), 'daktar', 1, { tenantId: TENANT_B })).rejects.toThrow(
        /row-level security/,
      );
      await log(anon(TENANT_A), 'in a', 1);
      await log(anon(TENANT_B), 'in b', 2);

      const read = (context: Context) =>
        as(
          app,
          context,
          (tx) =>
            tx<{ q_normalized: string }[]>`
            select q_normalized from search_queries
            where tenant_id::text like ${FIXTURE} order by q_normalized`,
        );
      // Only tenant A's admin reads A's log, and only A's.
      expect((await read(tenantAdmin(TENANT_A))).map((r) => r.q_normalized)).toEqual(['in a']);
      expect((await read(tenantAdmin(TENANT_B))).map((r) => r.q_normalized)).toEqual(['in b']);
      // The public, members and moderators read nothing at all.
      expect(await read(anon(TENANT_A))).toEqual([]);
      expect(await read(member(TENANT_A, USER_1))).toEqual([]);
      expect(await read(moderator(TENANT_A))).toEqual([]);
      // The platform (the zero-result report) reads every tenant.
      expect((await read(SYSTEM)).map((r) => r.q_normalized)).toEqual(['in a', 'in b']);
    });

    it('lets nobody but the platform update or delete a row directly', async () => {
      const id = await log(anon(TENANT_A), 'daktar', 1);
      for (const context of [anon(TENANT_A), tenantAdmin(TENANT_A)]) {
        await expect(
          as(
            app,
            context,
            (tx) => tx`update search_queries set result_count = 99 where id = ${id}`,
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          as(app, context, (tx) => tx`delete from search_queries where id = ${id}`),
        ).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe('record_search_click', () => {
    it("records a click once, on the searcher's own search in its own tenant", async () => {
      const anonymous = await log(anon(TENANT_A), 'daktar', 1);
      const signedIn = await log(member(TENANT_A, USER_1), 'daktar', 2, { userId: USER_1 });

      // From another tenant: not found.
      expect(await click(anon(TENANT_B), anonymous, POST)).toBe(false);
      // Someone else's signed-in search: refused, even for another signed-in user.
      expect(await click(anon(TENANT_A), signedIn, POST)).toBe(false);
      expect(await click(member(TENANT_A, USER_2), signedIn, POST)).toBe(false);

      expect(await click(anon(TENANT_A), anonymous, POST)).toBe(true);
      expect(await click(member(TENANT_A, USER_1), signedIn, POST)).toBe(true);
      // Once only.
      expect(await click(anon(TENANT_A), anonymous, POST)).toBe(false);

      const rows = await admin<{ clicked_post_id: string }[]>`
        select clicked_post_id from search_queries where id in (${anonymous}, ${signedIn})`;
      expect(rows.map((r) => r.clicked_post_id)).toEqual([POST, POST]);
    });

    it('refuses a stale search and a post that is not public', async () => {
      const old = await log(anon(TENANT_A), 'daktar', 1);
      await admin`update search_queries set created_at = now() - interval '2 hours' where id = ${old}`;
      expect(await click(anon(TENANT_A), old, POST, 60)).toBe(false);

      const fresh = await log(anon(TENANT_A), 'daktar', 1);
      await admin`update posts set status_code = 'draft' where id = ${POST_SCRUBBED}`;
      expect(await click(anon(TENANT_A), fresh, POST_SCRUBBED)).toBe(false);
      await admin`update posts set status_code = 'live' where id = ${POST_SCRUBBED}`;
      await expect(click(anon(TENANT_A), fresh, POST, 0)).rejects.toThrow(/positive window/);
    });
  });

  describe('search_popular_queries', () => {
    it('counts distinct searchers, so one person searching many times cannot make a query trend', async () => {
      for (let i = 0; i < 10; i += 1) await log(anon(TENANT_A), 'one person', 1);
      for (const searcher of [1, 2, 3]) await log(anon(TENANT_A), 'daktar', searcher);
      await log(anon(TENANT_A), 'daktar', 3);
      for (const searcher of [4, 5]) await log(anon(TENANT_A), 'basa vara', searcher);

      expect(await popular(anon(TENANT_A), 3)).toEqual([
        { q_normalized: 'daktar', searchers: '3', searches: '4' },
      ]);
      expect((await popular(anon(TENANT_A), 2)).map((r) => r.q_normalized)).toEqual([
        'daktar',
        'basa vara',
      ]);
    });

    it('covers the current tenant only, and leaves out searches that found nothing', async () => {
      for (const searcher of [1, 2, 3]) {
        await log(anon(TENANT_B), 'in b', searcher);
        await log(anon(TENANT_A), 'nothing here', searcher, { resultCount: 0 });
      }
      expect(await popular(anon(TENANT_A), 1)).toEqual([]);
      expect((await popular(anon(TENANT_B), 1)).map((r) => r.q_normalized)).toEqual(['in b']);
    });
  });

  it('a scrubbed post leaves the log too, and its scrub emits the search sync that removes it', async () => {
    const id = await log(anon(TENANT_A), 'gopon', 1);
    expect(await click(anon(TENANT_A), id, POST_SCRUBBED)).toBe(true);
    await clearEvents();

    // The moderation path itself is covered by trust-moderation.db-spec; here only its effect.
    await admin.begin(async (tx) => {
      await tx`
        insert into moderation_actions
          (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
        values (${TENANT_A}, ${POST_SCRUBBED}, ${USER_2}, 'moderator_removed', 'doxxing', 'fixture', '["e1"]')`;
      await tx`select scrub_post(${POST_SCRUBBED}::uuid, 'doxxing', 'moderator_removed')`;
    });

    const [row] = await admin<{ clicked_post_id: string | null }[]>`
      select clicked_post_id from search_queries where id = ${id}`;
    expect(row!.clicked_post_id).toBeNull();
    const [sync] = await admin<{ n: string }[]>`
      select count(*) as n from outbox_events
      where event_type = 'search.sync' and aggregate_id = ${POST_SCRUBBED}`;
    expect(Number(sync!.n)).toBeGreaterThan(0);
  });

  describe('boost slot cap fan-out', () => {
    it('a boost change re-syncs its category; a cap change re-syncs every boosted post', async () => {
      const [boostType] = await admin<{ id: string }[]>`
        select bt.id from boost_types bt where bt.placement_code = 'category_top' order by bt.id limit 1`;
      if (boostType === undefined) return; // no category_top boost type seeded here
      await admin`
        insert into boosts (tenant_id, boost_type_id, post_id, purchased_by_member_id, starts_at, ends_at, cost_credits, status_code)
        values (${TENANT_A}, ${boostType.id}, ${POST}, ${MEMBER_1}, now(), now() + interval '1 day', 0, 'active')`;
      expect(await resyncEvents()).toEqual([
        {
          aggregate_table: 'boosts',
          payload: { scope: 'boost_post', tenant_id: TENANT_A, post_id: POST },
        },
      ]);

      await clearEvents();
      await admin`
        update tenant_settings set setting_overrides = '{"boost_slots_per_category": 1}'
        where tenant_id = ${TENANT_A}`;
      // An unrelated override doesn't.
      await admin`
        update tenant_settings set setting_overrides = setting_overrides || '{"feed_page_size_default": 10}'
        where tenant_id = ${TENANT_A}`;
      expect(await resyncEvents()).toEqual([
        { aggregate_table: 'tenant_settings', payload: { scope: 'boosted', tenant_id: TENANT_A } },
      ]);

      await clearEvents();
      await admin`
        update platform_settings set value = to_jsonb((value #>> '{}')::integer + 1)
        where key = 'boost_slots_per_category'`;
      await admin`
        update platform_settings set value = to_jsonb((value #>> '{}')::integer - 1)
        where key = 'boost_slots_per_category'`;
      expect((await resyncEvents()).map((e) => e.payload)).toEqual([
        { scope: 'boosted' },
        { scope: 'boosted' },
      ]);
    });

    it('a category starting or stopping to ship re-syncs its documents (scope=country)', async () => {
      await admin`update categories set is_shippable = not is_shippable where id = ${CATEGORY}`;
      expect(await resyncEvents()).toEqual([
        { aggregate_table: 'categories', payload: { scope: 'category', category_id: CATEGORY } },
      ]);
      await admin`update categories set is_shippable = not is_shippable where id = ${CATEGORY}`;
    });
  });
});

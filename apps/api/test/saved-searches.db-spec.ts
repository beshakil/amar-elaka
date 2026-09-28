import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0035 (ADR 041):
 *  - saved_search_matches: the owner reads and marks seen their own rows;
 *    nobody else sees them; only the matcher (system) writes them;
 *  - saved_search_watermarks: system only;
 *  - a post that leaves live drops its unseen matches; a scrub drops all;
 *  - unmet_demand: never readable directly; unmet_demand_for_tenant() gives
 *    a tenant's admins that tenant's rows only; refresh_unmet_demand() is
 *    system only and recounts with the settings of the moment.
 */

const P = '0191e3a0-5a5e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const OWNER = `${P}000000000031`;
const OTHER = `${P}000000000032`;
const ADMIN_A = `${P}000000000033`;
const MEMBER = `${P}000000000041`;
const CATEGORY = `${P}000000000051`;
const SCHEMA = `${P}000000000061`;
const POST = `${P}000000000071`;
const POST_2 = `${P}000000000072`;
const SEARCH = `${P}000000000081`;
const SEARCH_PAUSED = `${P}000000000082`;
const SEARCH_B = `${P}000000000083`;

const LAT = 24.5;
const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 24.45,${east} 24.45,${east} 24.55,${west} 24.55,${west} 24.45)))`;
const point = (lng: number) => `SRID=4326;POINT(${lng} ${LAT})`;

type Context = Record<string, string>;
const user = (id: string, tenant = TENANT_A): Context => ({
  tenant_id: tenant,
  user_id: id,
  role: 'member',
});
const tenantAdmin = (tenant: string): Context => ({
  tenant_id: tenant,
  user_id: ADMIN_A,
  role: 'tenant_admin',
});
const SYSTEM: Context = { role: 'system' };

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

describe('Saved searches and unmet demand (0035)', () => {
  let admin: Sql;
  let app: Sql;

  const match = (post: string, seen = false) =>
    admin`
      insert into saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id, seen_at)
      values (${SEARCH}, ${OWNER}, ${post}, ${TENANT_A}, ${seen ? new Date() : null})`;
  const matchesOf = async (post: string) =>
    (
      await admin<{ seen: boolean }[]>`
        select seen_at is not null as seen from saved_search_matches where post_id = ${post}`
    ).map((r) => r.seen);

  async function cleanUp(): Promise<void> {
    await admin`delete from saved_search_matches where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_searches where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_search_watermarks where tenant_id::text like ${FIXTURE}`;
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
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
        (${OWNER}, '+8801766510001'), (${OTHER}, '+8801766510002'), (${ADMIN_A}, '+8801766510003')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Saved Search Partner', 'Saved Search Partner', '+8801766510099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'saved-search-a', 'Saved A', 'সেভড এ', 'fixture', ${square(88.0, 88.1)}, ${square(88.0, 88.1)}),
        (${AREA_B}, 3, 'upazila', 'saved-search-b', 'Saved B', 'সেভড বি', 'fixture', ${square(88.1, 88.2)}, ${square(88.1, 88.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'saved-search-a', 'এ', 'A', ${point(88.05)}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'saved-search-b', 'বি', 'B', ${point(88.15)}, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code)
      values (${MEMBER}, ${TENANT_A}, ${OTHER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'saved-search-cat', 'ক', 'C')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, '{"type":"object"}', 'published', now())`;
    for (const id of [POST, POST_2]) {
      await admin`
        insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code, published_at)
        values (${id}, ${TENANT_A}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, 'বাসা', 'live', now())`;
    }
    await admin`
      insert into saved_searches (id, user_id, name, category_id, center, radius_km, alert_frequency_code, paused_at)
      values
        (${SEARCH}, ${OWNER}, 'A', ${CATEGORY}, ${point(88.05)}, 5, 'instant', null),
        (${SEARCH_PAUSED}, ${OWNER}, 'A paused', ${CATEGORY}, ${point(88.05)}, 5, 'instant', now()),
        (${SEARCH_B}, ${OTHER}, 'B', null, ${point(88.15)}, 5, 'daily', null)`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
      await as(admin, SYSTEM, (tx) => tx`select refresh_unmet_demand()`);
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  beforeEach(async () => {
    await admin`delete from saved_search_matches where user_id::text like ${FIXTURE}`;
  });

  describe('saved_search_matches', () => {
    it('the owner reads their matches; nobody else does, in any tenant', async () => {
      await match(POST);
      const read = (context: Context) =>
        as(
          app,
          context,
          (tx) => tx`select post_id from saved_search_matches where user_id = ${OWNER}`,
        );
      expect(await read(user(OWNER))).toHaveLength(1);
      expect(await read(user(OWNER, TENANT_B))).toHaveLength(1); // global to the user (§13.29)
      expect(await read(user(OTHER))).toHaveLength(0);
      expect(await read(tenantAdmin(TENANT_A))).toHaveLength(0);
      expect(await read({ tenant_id: TENANT_A, role: 'anon' })).toHaveLength(0);
    });

    it('the owner may only mark them seen; only the matcher (system) writes them', async () => {
      await match(POST);
      await as(
        app,
        user(OWNER),
        (tx) => tx`update saved_search_matches set seen_at = now() where post_id = ${POST}`,
      );
      expect(await matchesOf(POST)).toEqual([true]);
      await expect(
        as(
          app,
          user(OWNER),
          (tx) => tx`update saved_search_matches set post_id = ${POST_2} where post_id = ${POST}`,
        ),
      ).rejects.toThrow(/permission denied/);
      // Another user's update touches nothing.
      await match(POST_2);
      await as(
        app,
        user(OTHER),
        (tx) => tx`update saved_search_matches set seen_at = now() where post_id = ${POST_2}`,
      );
      expect(await matchesOf(POST_2)).toEqual([false]);
      await expect(
        as(
          app,
          user(OWNER),
          (tx) => tx`
            insert into saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id)
            values (${SEARCH}, ${OWNER}, ${POST}, ${TENANT_A})`,
        ),
      ).rejects.toThrow(/row-level security/);
      await as(
        app,
        SYSTEM,
        (tx) => tx`
          insert into saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id)
          values (${SEARCH_B}, ${OTHER}, ${POST}, ${TENANT_A})`,
      );
    });

    it('a post that stops being live drops its unseen matches; seen ones stay', async () => {
      await match(POST, true);
      await admin`
        insert into saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id)
        values (${SEARCH_B}, ${OTHER}, ${POST}, ${TENANT_A})`;
      await admin`update posts set status_code = 'sold', sold_at = now() where id = ${POST}`;
      expect(await matchesOf(POST)).toEqual([true]);
      await admin`update posts set status_code = 'live', sold_at = null where id = ${POST}`;
    });

    it('a scrubbed post drops every match', async () => {
      await match(POST_2, true);
      await admin.begin(async (tx) => {
        await tx`
          insert into moderation_actions
            (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
          values (${TENANT_A}, ${POST_2}, ${ADMIN_A}, 'moderator_removed', 'doxxing', 'fixture', '["e1"]')`;
        await tx`select scrub_post(${POST_2}::uuid, 'doxxing', 'moderator_removed')`;
      });
      expect(await matchesOf(POST_2)).toEqual([]);
    });
  });

  it('saved_search_watermarks: system only', async () => {
    const write = (context: Context) =>
      as(
        app,
        context,
        (tx) => tx`
          insert into saved_search_watermarks (tenant_id, last_published_at, last_post_id)
          values (${TENANT_A}, now(), ${POST})
          on conflict (tenant_id) do update set last_published_at = excluded.last_published_at`,
      );
    await expect(write(tenantAdmin(TENANT_A))).rejects.toThrow(/row-level security/);
    await write(SYSTEM);
    const read = (context: Context) =>
      as(
        app,
        context,
        (tx) => tx`select tenant_id from saved_search_watermarks where tenant_id = ${TENANT_A}`,
      );
    expect(await read(tenantAdmin(TENANT_A))).toHaveLength(0);
    expect(await read(SYSTEM)).toHaveLength(1);
  });

  describe('unmet_demand', () => {
    const forTenant = (context: Context) =>
      as(
        app,
        context,
        (tx) =>
          tx<
            {
              category_id: string | null;
              geo_area_id: string | null;
              active_saved_searches: number;
              weak_searches: number;
            }[]
          >`select category_id, geo_area_id, active_saved_searches, weak_searches from unmet_demand_for_tenant()`,
      );

    beforeAll(async () => {
      const log = (tenant: string, results: number, age: string, origin: string | null) =>
        admin`
          insert into search_queries
            (tenant_id, searcher_hash, q_normalized, filters_hash, result_count, category_id, origin, created_at)
          values (${tenant}, ${'a'.repeat(64)}, 'basa', '0123456789abcdef', ${results}, ${CATEGORY},
                  ${origin}, now() - ${age}::interval)`;
      await log(TENANT_A, 0, '1 day', point(88.05)); // weak
      await log(TENANT_A, 2, '2 days', point(88.05)); // weak (< 3)
      await log(TENANT_A, 10, '1 day', point(88.05)); // found enough
      await log(TENANT_A, 0, '40 days', point(88.05)); // outside the window
      await log(TENANT_B, 0, '1 day', null);
      await as(admin, SYSTEM, (tx) => tx`select refresh_unmet_demand()`);
    });

    it('is never readable directly', async () => {
      await expect(
        as(app, tenantAdmin(TENANT_A), (tx) => tx`select tenant_id from unmet_demand`),
      ).rejects.toThrow(/permission denied/);
    });

    it("gives a tenant's admins that tenant's rows only, counted as specified", async () => {
      expect(await forTenant(tenantAdmin(TENANT_A))).toEqual([
        // One active saved search in A's area (the paused one doesn't count), two weak searches.
        { category_id: CATEGORY, geo_area_id: AREA_A, active_saved_searches: 1, weak_searches: 2 },
      ]);
      const b = await forTenant(tenantAdmin(TENANT_B));
      expect(b).toEqual(
        expect.arrayContaining([
          { category_id: null, geo_area_id: AREA_B, active_saved_searches: 1, weak_searches: 0 },
          { category_id: CATEGORY, geo_area_id: null, active_saved_searches: 0, weak_searches: 1 },
        ]),
      );
    });

    it('refuses members; only the system refreshes', async () => {
      await expect(forTenant(user(OTHER))).rejects.toThrow(/tenant admins only/);
      await expect(
        as(app, tenantAdmin(TENANT_A), (tx) => tx`select refresh_unmet_demand()`),
      ).rejects.toThrow(/system only/);
    });

    it('recounts on refresh, with the threshold of the moment', async () => {
      await admin`update platform_settings set value = '11' where key = 'unmet_demand_result_threshold'`;
      try {
        await as(app, SYSTEM, (tx) => tx`select refresh_unmet_demand()`);
        const [row] = await forTenant(tenantAdmin(TENANT_A));
        expect(row!.weak_searches).toBe(3);
      } finally {
        await admin`update platform_settings set value = '3' where key = 'unmet_demand_result_threshold'`;
        await as(app, SYSTEM, (tx) => tx`select refresh_unmet_demand()`);
      }
    });
  });
});

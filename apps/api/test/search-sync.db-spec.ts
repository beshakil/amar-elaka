import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0020: every change that alters a search document writes a
 * search.* outbox event in the same transaction, noise (view counts, the
 * sync stamp itself) writes none, and a noise-only update keeps a synced row
 * synced. Setup runs as the superuser; the writes under test run as ae_app in
 * a member or system context, like the application.
 */

const PARTNER = '0191e3a0-9191-7000-8000-000000000001';
const GEO_AREA = '0191e3a0-9191-7000-8000-000000000011';
const TENANT = '0191e3a0-9191-7000-8000-000000000021';
const USER = '0191e3a0-9191-7000-8000-000000000031';
const MEMBER = '0191e3a0-9191-7000-8000-000000000041';
const CATEGORY = '0191e3a0-9191-7000-8000-000000000051';
const SCHEMA = '0191e3a0-9191-7000-8000-000000000061';
const POST = '0191e3a0-9191-7000-8000-000000000071';
const LOCALITY = '0191e3a0-9191-7000-8000-000000000081';
const MEDIA = '0191e3a0-9191-7000-8000-000000000091';
const FIXTURE_PREFIX = '0191e3a0-9191-7000-8000-%';

const SYSTEM = { role: 'system', is_platform_admin: 'true' };
const MEMBER_CONTEXT = { tenant_id: TENANT, user_id: USER, member_id: MEMBER, role: 'member' };

async function as<T>(
  sql: Sql,
  context: Record<string, string>,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

interface EventRow {
  event_type: string;
  aggregate_table: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

describe('Search sync outbox triggers (0020)', () => {
  let admin: Sql;
  let app: Sql;

  const events = () =>
    admin<EventRow[]>`
      select event_type, aggregate_table, aggregate_id::text, payload from outbox_events
      where event_type like 'search.%'
        and (aggregate_id::text like ${FIXTURE_PREFIX} or payload::text like ${`%${TENANT}%`})
      order by occurred_at, id`;
  const clearEvents = () =>
    admin`
      delete from outbox_events
      where event_type like 'search.%'
        and (aggregate_id::text like ${FIXTURE_PREFIX} or payload::text like ${`%${TENANT}%`})`;

  async function cleanUp(): Promise<void> {
    await admin`delete from boosts where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from localities where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await clearEvents();
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`insert into users (id, phone_e164) values (${USER}, '+8801766000201')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Search Sync Partner', 'Search Sync Partner', '+8801766000299')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${GEO_AREA}, 3, 'upazila', 'search-sync-a', 'Search Sync Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'search-sync', 'স', 'S', st_point(90.4, 23.8)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'search-sync-cat', 'ক', 'C')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, '{"type":"object"}', 'published', now())`;
    await admin`
      insert into localities (id, tenant_id, name_bn, name_en) values (${LOCALITY}, ${TENANT}, 'মিরপুর', 'Mirpur')`;
    await clearEvents();
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  beforeEach(clearEvents);

  it('a new post emits one search.sync for it, with its tenant', async () => {
    await as(
      app,
      MEMBER_CONTEXT,
      (tx) => tx`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title)
      values (${POST}, ${TENANT}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, 'ডাক্তার')`,
    );
    expect(await events()).toEqual([
      {
        event_type: 'search.sync',
        aggregate_table: 'posts',
        aggregate_id: POST,
        payload: { tenant_id: TENANT },
      },
    ]);
  });

  it('a real edit emits; a view count or the sync stamp does not, and a synced row stays synced', async () => {
    await as(
      app,
      MEMBER_CONTEXT,
      (tx) => tx`update posts set title = 'ডাক্তার রহিম' where id = ${POST}`,
    );
    expect(await events()).toHaveLength(1);
    await clearEvents();

    // The indexer's own write.
    await as(app, SYSTEM, (tx) => tx`update posts set search_synced_at = now() where id = ${POST}`);
    // A view.
    await as(
      app,
      SYSTEM,
      (tx) => tx`update posts set view_count = view_count + 1 where id = ${POST}`,
    );
    expect(await events()).toEqual([]);

    const [row] = await admin<{ in_sync: boolean }[]>`
      select search_synced_at >= updated_at as in_sync from posts where id = ${POST}`;
    expect(row?.in_sync).toBe(true);
  });

  it('a boost starting or ending re-syncs its post', async () => {
    const [boostType] = await admin<
      { id: string }[]
    >`select id from boost_types order by id limit 1`;
    if (boostType === undefined) return; // no boost types seeded in this database
    await admin`
      insert into boosts (tenant_id, boost_type_id, post_id, purchased_by_member_id, starts_at, ends_at, cost_credits, status_code)
      values (${TENANT}, ${boostType.id}, ${POST}, ${MEMBER}, now(), now() + interval '1 day', 0, 'active')`;
    expect(await events()).toEqual([
      expect.objectContaining({
        event_type: 'search.sync',
        aggregate_table: 'posts',
        aggregate_id: POST,
      }),
    ]);
  });

  it('a category rename re-syncs the category; disabling it in a tenant re-syncs that tenant', async () => {
    await as(
      app,
      SYSTEM,
      (tx) => tx`update categories set name_en = 'Doctors' where id = ${CATEGORY}`,
    );
    await as(
      app,
      SYSTEM,
      (tx) => tx`
      insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, false)`,
    );
    const emitted = await events();
    expect(emitted).toEqual([
      expect.objectContaining({
        event_type: 'search.resync',
        payload: { scope: 'category', category_id: CATEGORY },
      }),
      expect.objectContaining({
        event_type: 'search.resync',
        payload: { scope: 'tenant_category', tenant_id: TENANT, category_id: CATEGORY },
      }),
    ]);

    await clearEvents();
    await as(
      app,
      SYSTEM,
      (tx) => tx`update categories set default_sort_order = 5 where id = ${CATEGORY}`,
    );
    expect(await events()).toEqual([]);
  });

  it('a locality alias re-applies synonyms; a rename also re-syncs its documents', async () => {
    await as(
      app,
      SYSTEM,
      (tx) => tx`update localities set aliases = '{mirpur-10}' where id = ${LOCALITY}`,
    );
    expect((await events()).map((e) => e.event_type)).toEqual(['search.settings']);
    await clearEvents();

    await as(
      app,
      SYSTEM,
      (tx) => tx`update localities set name_en = 'Mirpur 10' where id = ${LOCALITY}`,
    );
    expect((await events()).map((e) => e.event_type).sort()).toEqual([
      'search.resync',
      'search.settings',
    ]);
  });

  it('banning a member re-syncs their content; a restriction does not', async () => {
    await admin`update tenant_members set ban_severity_code = 'restricted' where id = ${MEMBER}`;
    expect(await events()).toEqual([]);
    await admin`update tenant_members set ban_severity_code = 'banned' where id = ${MEMBER}`;
    expect(await events()).toEqual([
      expect.objectContaining({
        event_type: 'search.resync',
        payload: { scope: 'member', tenant_id: TENANT, member_id: MEMBER },
      }),
    ]);
    await admin`update tenant_members set ban_severity_code = null where id = ${MEMBER}`;
  });

  it('a photo becoming ready re-syncs the posts showing it (whoever changes it)', async () => {
    await admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, storage_key, mime_type, byte_size, checksum_sha256, status_code)
      values (${MEDIA}, ${TENANT}, ${USER}, 'image', 'search-sync/photo', 'image/webp', 10, ${'a'.repeat(64)}, 'processing')`;
    await admin`insert into media_attachments (tenant_id, media_asset_id, post_id) values (${TENANT}, ${MEDIA}, ${POST})`;
    await clearEvents();

    await as(
      app,
      SYSTEM,
      (tx) => tx`update media_assets set status_code = 'ready' where id = ${MEDIA}`,
    );
    expect(await events()).toEqual([
      expect.objectContaining({
        event_type: 'search.sync',
        aggregate_table: 'posts',
        aggregate_id: POST,
      }),
    ]);
  });

  it('deleting a post emits a sync (the relay then removes it from the index)', async () => {
    await admin`delete from boosts where post_id = ${POST}`;
    await admin`delete from media_attachments where post_id = ${POST}`;
    await clearEvents();
    await admin`delete from posts where id = ${POST}`;
    expect(await events()).toEqual([
      expect.objectContaining({
        event_type: 'search.sync',
        aggregate_table: 'posts',
        aggregate_id: POST,
      }),
    ]);
  });

  it('seeds the search settings', async () => {
    const rows = await admin<
      { key: string }[]
    >`select key from platform_settings where key like 'search_%' order by key`;
    expect(rows.map((r) => r.key)).toEqual([
      'search_default_radius_km',
      'search_facet_values_max',
      'search_max_radius_km',
      'search_max_total_hits',
      'search_outbox_max_attempts',
      'search_page_size_default',
      'search_page_size_max',
      'search_suggest_limit',
      'search_suggest_min_chars',
      'search_typo_one_typo_min_chars',
      'search_typo_two_typos_min_chars',
    ]);
  });
});

import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { SearchCliModule } from '../src/search/cli/search-cli.module';
import type {
  SearchResponse,
  SuggestResponse,
  TrendingResponse,
} from '../src/search/dto/search.dto';
import { SearchIndexer } from '../src/search/indexing/search-indexer.service';
import { SearchIndexingModule } from '../src/search/indexing/search-indexing.module';
import { SearchOutboxRelay } from '../src/search/indexing/search-outbox.relay';
import { SettingsModule } from '../src/settings/settings.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The search API end to end (ADR 040): real Postgres, Redis and Meilisearch.
 * Rows are written to Postgres, the worker's outbox relay (run in-process
 * here) carries them to the index, and GET /api/v1/search answers.
 *
 *  - ডাক্তার / daktar / doctor / dakter still return the same listing;
 *  - a sold post leaves search; a scrubbed post leaves everything, the
 *    query log included;
 *  - searches are logged (normalized), clicks recorded, and trending needs
 *    distinct searchers.
 *
 * Fixtures sit near Sylhet, away from other suites.
 */

const FIXTURE = '0191e3a0-5e2e-7000-8000-%';
const PARTNER = '0191e3a0-5e2e-7000-8000-000000000001';
const AREA = '0191e3a0-5e2e-7000-8000-000000000011';
const TENANT = '0191e3a0-5e2e-7000-8000-000000000021';
const USER = '0191e3a0-5e2e-7000-8000-000000000031';
const MODERATOR = '0191e3a0-5e2e-7000-8000-000000000032';
const MEMBER = '0191e3a0-5e2e-7000-8000-000000000041';
const CATEGORY = '0191e3a0-5e2e-7000-8000-000000000051';
const SCHEMA = '0191e3a0-5e2e-7000-8000-000000000061';
const DOCTOR = '0191e3a0-5e2e-7000-8000-000000000071';
const SOLD = '0191e3a0-5e2e-7000-8000-000000000072';
const SCRUBBED = '0191e3a0-5e2e-7000-8000-000000000073';
const LOCALITY = '0191e3a0-5e2e-7000-8000-000000000081';

const CENTER = { lat: 24.9, lng: 91.87 };
const point = (lng: number) => `SRID=4326;POINT(${lng} ${CENTER.lat})`;
const square =
  'SRID=4326;MULTIPOLYGON(((91.8 24.85,91.95 24.85,91.95 24.95,91.8 24.95,91.8 24.85)))';

describe('Search API (e2e)', () => {
  let app: NestFastifyApplication;
  let worker: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
  let relay: SearchOutboxRelay;
  let admin: Sql;
  let redis: Redis;

  const get = async <T>(
    path: string,
    query: Record<string, string>,
    installId = 'e2e-install-1',
  ) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/search${path}`,
      query,
      headers: { 'x-tenant-id': TENANT, 'x-install-id': installId },
    });
    return { status: response.statusCode, body: response.json<T>() };
  };
  const search = (query: Record<string, string>, installId?: string) =>
    get<SearchResponse>('', query, installId);
  const ids = (response: SearchResponse) => response.hits.map((h) => h.id).sort();

  /** Everything written so far reaches the index. */
  const drain = async () => {
    while ((await relay.relay()) > 0);
  };

  async function cleanUp(): Promise<void> {
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from localities where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    redis = new Redis(process.env.REDIS_URL!);
    await cleanUp();
    // Trending and the other per-tenant lists are cached: start clean.
    const stale = await redis.keys(`cache:${TENANT}:search:*`);
    if (stale.length > 0) await redis.del(...stale);

    await admin`
      insert into users (id, phone_e164) values
        (${USER}, '+8801755700001'), (${MODERATOR}, '+8801755700002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Search E2E Partner', 'Search E2E Partner', '+8801755700099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'search-e2e', 'Search E2E', 'সার্চ', 'fixture', ${square}, ${square})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'search-e2e', 'সার্চ', 'Search', ${point(CENTER.lng)}, 'active')`;
    // Two distinct searchers make a query trend here.
    await admin`
      insert into tenant_settings (tenant_id, setting_overrides)
      values (${TENANT}, '{"search_trending_min_searchers": 2, "seo_area_page_min_listings": 1}'::jsonb)`;
    // One area with a centre, for the category + area landing pages (ADR 042).
    await admin`
      insert into localities (id, tenant_id, name_bn, name_en, center)
      values (${LOCALITY}, ${TENANT}, 'উপশহর', 'Upashahar', ${point(CENTER.lng)})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code)
      values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'search-e2e-doctors', 'ডাক্তার', 'Doctors')`;
    await admin`
      insert into category_field_schemas
        (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1,
              '{"type":"object","additionalProperties":false,"required":[],"properties":{}}',
              '{"order":[],"card":[],"labels":{}}', 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled)
      values (${TENANT}, ${CATEGORY}, true)`;
    for (const [id, title, lng] of [
      [DOCTOR, 'ডাক্তার করিম — শিশু বিশেষজ্ঞ', 91.871],
      [SOLD, 'ডাক্তারের চেম্বারের চেয়ার বিক্রি', 91.872],
      [SCRUBBED, 'ডাক্তার গোপন চেম্বার', 91.873],
    ] as const) {
      await admin`
        insert into posts
          (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
           published_at, location, geo_area_id, price_type_code, fields)
        values (${id}, ${TENANT}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, ${title}, 'live',
                now() - interval '1 hour', ${point(lng)}, ${AREA}, 'fixed', '{"price": "500.00"}'::jsonb)`;
    }

    // The doctor's post is in the area; the others have none.
    await admin`update posts set locality_id = ${LOCALITY} where id = ${DOCTOR}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // The worker's side, in-process: index settings (synonyms), then the relay.
    worker = await Test.createTestingModule({
      imports: [SearchCliModule, SearchIndexingModule, SettingsModule],
      providers: [SearchOutboxRelay],
    }).compile();
    await worker.init();
    await worker.get(SearchIndexer).applySettings();
    relay = worker.get(SearchOutboxRelay);
    await drain();
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanUp();
      if (relay) await drain();
    } finally {
      await admin.end();
      redis.disconnect();
      await worker?.close();
      await app?.close();
    }
  }, 60_000);

  it('ডাক্তার / daktar / doctor / dakter all return the same listings', async () => {
    const results = [];
    for (const q of ['ডাক্তার', 'daktar', 'doctor', 'dakter']) {
      const { status, body } = await search({ q });
      expect(status).toBe(200);
      expect(body.degraded).toBe(false);
      results.push(ids(body));
    }
    expect(results[0]).toEqual([DOCTOR, SCRUBBED, SOLD].sort());
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it('a post marked sold leaves search within one relay run', async () => {
    await admin`update posts set status_code = 'sold', sold_at = now() where id = ${SOLD}`;
    const [event] = await admin<{ n: string }[]>`
      select count(*) as n from outbox_events
      where event_type = 'search.sync' and aggregate_id = ${SOLD} and processed_at is null`;
    expect(Number(event!.n)).toBeGreaterThan(0);

    await drain();
    const { body } = await search({ q: 'daktar' });
    expect(ids(body)).not.toContain(SOLD);
    expect(ids(body)).toContain(DOCTOR);
  });

  it('logs searches (normalized), records the click, and trends only with distinct searchers', async () => {
    const first = await search({ q: '  DAKTAR  ' }, 'e2e-install-1');
    expect(first.body.searchId).toMatch(/^[0-9a-f-]{36}$/);
    await search({ q: 'daktar' }, 'e2e-install-2');
    for (let i = 0; i < 4; i += 1) await search({ q: 'one person only' }, 'e2e-install-3');

    const rows = await admin<
      { q_normalized: string; result_count: number; user_id: string | null }[]
    >`
      select q_normalized, result_count, user_id from search_queries
      where tenant_id = ${TENANT} order by created_at desc limit 6`;
    // Newest first: four of "one person only" (nothing found), then the two "daktar".
    expect(rows.slice(4)).toEqual([
      { q_normalized: 'daktar', result_count: 2, user_id: null },
      { q_normalized: 'daktar', result_count: 2, user_id: null },
    ]);
    expect(rows.slice(0, 4).every((r) => r.result_count === 0)).toBe(true);
    // Never the raw text.
    const [raw] = await admin<{ n: string }[]>`
      select count(*) as n from search_queries where q_normalized <> btrim(lower(q_normalized))`;
    expect(Number(raw!.n)).toBe(0);

    const clicked = await app.inject({
      method: 'POST',
      url: '/api/v1/search/click',
      headers: { 'x-tenant-id': TENANT },
      payload: { searchId: first.body.searchId, postId: SCRUBBED },
    });
    expect(clicked.json()).toEqual({ recorded: true });

    // "one person only" found nothing and had one searcher: it never trends.
    const trending = await get<TrendingResponse>('/trending', {});
    expect(trending.body).toEqual({
      windowHours: 24,
      queries: [{ query: 'daktar', searchers: 2 }],
    });
  });

  it('suggests categories, popular queries and listing titles', async () => {
    const { status, body } = await get<SuggestResponse>('/suggest', { q: 'ডাক' });
    expect(status).toBe(200);
    expect(body.categories).toEqual([
      { slug: 'search-e2e-doctors', name: { bn: 'ডাক্তার', en: 'Doctors' } },
    ]);
    expect(body.listings.map((l) => l.id)).toContain(DOCTOR);
  });

  it('a scrubbed post disappears: from search, suggestions and the query log', async () => {
    await admin.begin(async (tx) => {
      await tx`
        insert into moderation_actions
          (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
        values (${TENANT}, ${SCRUBBED}, ${MODERATOR}, 'moderator_removed', 'doxxing', 'fixture', '["e1"]')`;
      await tx`select scrub_post(${SCRUBBED}::uuid, 'doxxing', 'moderator_removed')`;
    });
    await drain();

    for (const q of ['ডাক্তার', 'daktar', 'গোপন']) {
      expect(ids((await search({ q })).body)).not.toContain(SCRUBBED);
    }
    const suggest = await get<SuggestResponse>('/suggest', { q: 'ডাক্তার' });
    expect(suggest.body.listings.map((l) => l.id)).not.toContain(SCRUBBED);
    const [clicks] = await admin<{ n: string }[]>`
      select count(*) as n from search_queries where clicked_post_id = ${SCRUBBED}`;
    expect(Number(clicks!.n)).toBe(0);
  });

  it('lists the category + area pages with enough listings, counted like the page searches', async () => {
    const areas = await app.inject({
      method: 'GET',
      url: '/api/v1/seo/category-areas',
      headers: { 'x-tenant-id': TENANT },
    });
    expect(areas.statusCode).toBe(200);
    expect(areas.json()).toEqual({
      minListings: 1,
      items: [
        {
          category: { slug: 'search-e2e-doctors', name: { bn: 'ডাক্তার', en: 'Doctors' } },
          area: { slug: 'upashahar', name: { bn: 'উপশহর', en: 'Upashahar' } },
          count: 1,
        },
      ],
    });

    // The landing page's own search: the same one listing, and the area named.
    const { status, body } = await search({ category: 'search-e2e-doctors', area: 'upashahar' });
    expect(status).toBe(200);
    expect(ids(body)).toEqual([DOCTOR]);
    expect(body.totalHits).toBe(1);
    expect(body.area).toEqual({ slug: 'upashahar', name: { bn: 'উপশহর', en: 'Upashahar' } });
    expect((await search({ area: 'no-such-area' })).status).toBe(404);
  });

  it('validates input and refuses a foreign cursor', async () => {
    expect((await search({ sort: 'distance' })).status).toBe(400);
    expect((await search({ scope: 'everywhere' })).status).toBe(400);
    const page = await search({ q: 'daktar', limit: '1' });
    expect(page.body.nextCursor).toBeNull(); // one live doctor left
    const bogus = await search({ q: 'daktar', cursor: 'eyJ2IjoxfQ' });
    expect(bogus.status).toBe(400);
  });
});

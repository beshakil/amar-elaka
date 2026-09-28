import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import type { UnmetDemand } from '../src/analytics/dto/analytics.dto';
import { UnmetDemandService } from '../src/analytics/unmet-demand.service';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { SavedSearchAutoPauseService } from '../src/saved-searches/matching/saved-search-auto-pause.service';
import { SavedSearchMatcherService } from '../src/saved-searches/matching/saved-search-matcher.service';
import { SavedSearchNotifierService } from '../src/saved-searches/matching/saved-search-notifier.service';
import type {
  NewResults,
  SavedSearch,
  SavedSearchList,
} from '../src/saved-searches/dto/saved-searches.dto';
import { SavedSearchesRepository } from '../src/saved-searches/saved-searches.repository';
import { SearchCliModule } from '../src/search/cli/search-cli.module';
import type { SearchResponse } from '../src/search/dto/search.dto';
import { SearchIndexer } from '../src/search/indexing/search-indexer.service';
import { SearchIndexingModule } from '../src/search/indexing/search-indexing.module';
import { SearchOutboxRelay } from '../src/search/indexing/search-outbox.relay';
import { SearchCoreModule } from '../src/search/search-core.module';
import { SettingsModule } from '../src/settings/settings.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Saved searches end to end (ADR 041): real Postgres, Redis and
 * Meilisearch. The API runs as the app does; the worker's services (the
 * outbox relay, the matcher, the notifier, auto-pause, the unmet-demand
 * refresh) run in-process, exactly the code the scheduled jobs call.
 *
 * Fixtures sit near Rangpur, away from other suites.
 */

const P = '0191e3a0-5a5e-7e2e-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const OWNER = `${P}000000000031`;
const SELLER = `${P}000000000032`;
const ADMIN = `${P}000000000033`;
const M_OWNER = `${P}000000000041`;
const M_SELLER = `${P}000000000042`;
const M_ADMIN = `${P}000000000043`;
const CATEGORY = `${P}000000000051`;
const SCHEMA = `${P}000000000061`;

const LAT = 25.75;
const CENTER = { lat: LAT, lng: 89.25 };
const point = (lng: number) => `SRID=4326;POINT(${lng} ${LAT})`;
const square = 'SRID=4326;MULTIPOLYGON(((89.1 25.6,89.4 25.6,89.4 25.9,89.1 25.9,89.1 25.6)))';
const BUDGET = { batchSize: 50, maxBatches: 20 };

describe('Saved searches (e2e)', () => {
  let app: NestFastifyApplication;
  let worker: TestingModule;
  let admin: Sql;
  const tokens: Record<'owner' | 'seller' | 'admin', string> = { owner: '', seller: '', admin: '' };

  let n = 0x1000;
  const post = async (title: string, price: string, lng: number, author = M_SELLER) => {
    const id = `${P}${(n++).toString(16).padStart(12, '0')}`;
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
         published_at, location, geo_area_id, price_type_code, fields)
      values (${id}, ${TENANT}, ${author}, ${CATEGORY}, ${SCHEMA}, ${title}, 'live',
              now() - interval '10 minutes', ${point(lng)}, ${AREA}, 'fixed',
              ${admin.json({ price })})`;
    return id;
  };

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    as: keyof typeof tokens,
    body?: unknown,
  ) =>
    app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[as]}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      })
      .then((r) => ({ status: r.statusCode, body: (r.body ? r.json() : null) as T }));

  /** Index what was written, then run the matcher and the notifier: one scheduled run. */
  const runMatcher = async () => {
    const relay = worker.get(SearchOutboxRelay);
    while ((await relay.relay()) > 0);
    await worker.get(SavedSearchMatcherService).matchNewPosts(BUDGET);
    await worker.get(SavedSearchNotifierService).notifyPending(BUDGET);
  };

  const notifications = (type: string) =>
    admin<{ params: Record<string, string>; entity_id: string }[]>`
      select params, entity_id from notifications
      where user_id = ${OWNER} and type_code = ${type} order by created_at`;

  async function cleanUp(): Promise<void> {
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_search_matches where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_searches where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_search_watermarks where tenant_id::text like ${FIXTURE}`;
    await admin`delete from search_queries where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
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
    await cleanUp();
    await admin`
      insert into users (id, phone_e164) values
        (${OWNER}, '+8801755810001'), (${SELLER}, '+8801755810002'), (${ADMIN}, '+8801755810003')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Saved Search E2E', 'Saved Search E2E', '+8801755810099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'saved-e2e', 'Saved E2E', 'সেভড', 'fixture', ${square}, ${square})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'saved-e2e', 'সেভড', 'Saved', ${point(CENTER.lng)}, 'active')`;
    await admin`insert into tenant_settings (tenant_id, setting_overrides) values (${TENANT}, '{}')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT}, ${OWNER}, 'member'),
        (${M_SELLER}, ${TENANT}, ${SELLER}, 'member'),
        (${M_ADMIN}, ${TENANT}, ${ADMIN}, 'tenant_admin')`;
    // A neutral name: category names are searchable, and one containing "flat"
    // would make every post in it match q=flat (in search and saved searches alike).
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'saved-e2e-flats', 'তালিকা', 'Listings')`;
    await admin`
      insert into category_field_schemas
        (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1,
              '{"type":"object","additionalProperties":false,"required":[],"properties":{}}',
              '{"order":[],"card":[],"labels":{}}', 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;

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
    const signer = moduleRef.get(TokenService);
    for (const [name, userId, memberId, role] of [
      ['owner', OWNER, M_OWNER, 'member'],
      ['seller', SELLER, M_SELLER, 'member'],
      ['admin', ADMIN, M_ADMIN, 'tenant_admin'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({ userId, tenantId: TENANT, memberId, role });
    }

    // The worker's services, without the BullMQ processor and schedules.
    worker = await Test.createTestingModule({
      imports: [
        SearchCliModule,
        SearchIndexingModule,
        SearchCoreModule,
        NotificationsModule,
        SettingsModule,
      ],
      providers: [
        SearchOutboxRelay,
        SavedSearchesRepository,
        SavedSearchMatcherService,
        SavedSearchNotifierService,
        SavedSearchAutoPauseService,
        UnmetDemandService,
      ],
    }).compile();
    await worker.init();
    await worker.get(SearchIndexer).applySettings();
    // Fixture ids repeat from run to run: clear any documents a previous run left.
    await worker.get(SearchIndexer).syncByIds(
      'posts',
      Array.from({ length: 64 }, (_, i) => `${P}${(0x1000 + i).toString(16).padStart(12, '0')}`),
    );
    // First sight of the tenant sets its watermark to "now"; move it back so
    // the posts below (published 10 minutes ago) are new to the matcher.
    await worker.get(SavedSearchMatcherService).matchNewPosts(BUDGET);
    await admin`
      update saved_search_watermarks set last_published_at = now() - interval '1 hour'
      where tenant_id = ${TENANT}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanUp();
      // Carry the deletions to the index too.
      const relay = worker?.get(SearchOutboxRelay);
      if (relay) while ((await relay.relay()) > 0);
    } finally {
      await admin.end();
      await worker?.close();
      await app?.close();
    }
  }, 60_000);

  let flatSearch: SavedSearch;

  it('creates saved searches, checked like GET /search, up to saved_search_max_active', async () => {
    const created = await call<SavedSearch>('POST', '/saved-searches', 'owner', {
      name: 'Cheap flat nearby',
      q: 'flat',
      filters: { category: 'saved-e2e-flats', price_max: '20000' },
      center: CENTER,
      radius_km: 5,
      frequency: 'instant',
    });
    expect(created.status).toBe(201);
    flatSearch = created.body;
    expect(flatSearch).toMatchObject({
      q: 'flat',
      filters: { category: 'saved-e2e-flats', priceMax: '20000.00', priceMin: null },
      radiusKm: 5,
      frequency: 'instant',
      active: true,
      newResultCount: 0,
    });

    // The same rules as search: an unknown category, or fields without a schema.
    expect(
      (
        await call('POST', '/saved-searches', 'owner', {
          name: 'x',
          filters: { category: 'no-such-category' },
          center: CENTER,
          radius_km: 5,
        })
      ).status,
    ).toBe(404);

    // Four more (the default maximum is 5), then the sixth is refused.
    for (let i = 0; i < 4; i += 1) {
      const more = await call('POST', '/saved-searches', 'owner', {
        name: `Other ${i}`,
        q: `nothing-like-this-${i}`,
        center: CENTER,
        radius_km: 1,
        frequency: 'off',
      });
      expect(more.status).toBe(201);
    }
    const sixth = await call<{ error: string }>('POST', '/saved-searches', 'owner', {
      name: 'Too many',
      center: CENTER,
      radius_km: 1,
    });
    expect(sixth).toMatchObject({ status: 409, body: { error: 'SAVED_SEARCH_LIMIT_REACHED' } });

    // Nobody else sees them.
    const others = await call<SavedSearchList>('GET', '/saved-searches', 'seller');
    expect(others.body.items).toEqual([]);
    expect((await call('GET', `/saved-searches/${flatSearch.id}`, 'seller')).status).toBe(404);
  });

  let match1: string;
  let match2: string;

  it('matches new posts with the same meaning as search, and notifies once for all of them', async () => {
    match1 = await post('Flat for rent, 2 rooms', '15000.00', 89.26);
    match2 = await post('Sunny flat near the market', '18000.00', 89.24);
    const pricey = await post('Big flat', '30000.00', 89.25);
    const far = await post('Flat far away', '15000.00', 89.39); // ~14 km
    const bike = await post('Bike for sale', '15000.00', 89.25);
    const own = await post('My own flat', '15000.00', 89.25, M_OWNER);

    await runMatcher();

    // GET /search with the same parameters finds the same posts…
    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: {
        q: 'flat',
        category: 'saved-e2e-flats',
        price_max: '20000',
        lat: String(CENTER.lat),
        lng: String(CENTER.lng),
        scope: 'nearby',
        radius_km: '5',
      },
      headers: { 'x-tenant-id': TENANT },
    });
    const found = search.json<SearchResponse>().hits.map((h) => h.id);
    expect(found.sort()).toEqual([match1, match2, own].sort());
    expect(found).not.toEqual(expect.arrayContaining([pricey, far, bike]));

    // …and the saved search matched those, less the owner's own post.
    const list = await call<SavedSearchList>('GET', '/saved-searches', 'owner');
    expect(list.body.items.find((s) => s.id === flatSearch.id)!.newResultCount).toBe(2);
    expect(list.body).toMatchObject({ newResultCount: 2, maxActive: 5, activeCount: 5 });

    // One notification for both.
    expect(await notifications('saved_search_match')).toEqual([
      {
        entity_id: flatSearch.id,
        params: { savedSearchId: flatSearch.id, name: 'Cheap flat nearby', count: '2' },
      },
    ]);
    // Indexing and a matcher pass: slow when the e2e suites run in parallel (CI).
  }, 30_000);

  it('holds further notifications at the daily cap, while the badge keeps counting', async () => {
    await post('Flat with a balcony', '12000.00', 89.25);
    await runMatcher();
    expect(await notifications('saved_search_match')).toHaveLength(1);
    const one = await call<SavedSearch>('GET', `/saved-searches/${flatSearch.id}`, 'owner');
    expect(one.body.newResultCount).toBe(3);
  }, 30_000);

  it('drops a match that sold before it was opened; opening the rest marks them seen', async () => {
    await admin`update posts set status_code = 'sold', sold_at = now() where id = ${match2}`;
    const opened = await call<NewResults>(
      'GET',
      `/saved-searches/${flatSearch.id}/new-results`,
      'owner',
    );
    expect(opened.status).toBe(200);
    expect(opened.body.results.map((r) => r.id)).toContain(match1);
    expect(opened.body.results.map((r) => r.id)).not.toContain(match2);
    expect(opened.body.results).toHaveLength(2);
    expect(opened.body.search.newResultCount).toBe(0);
  });

  it('auto-pauses a search nobody opens, with a final notice; resuming counts against the limit', async () => {
    await admin`
      update saved_searches set last_engaged_at = now() - interval '31 days'
      where id = ${flatSearch.id}`;
    await worker.get(SavedSearchAutoPauseService).pauseIdle(BUDGET);

    const paused = await call<SavedSearch>('GET', `/saved-searches/${flatSearch.id}`, 'owner');
    expect(paused.body.active).toBe(false);
    expect(paused.body.pausedAt).not.toBeNull();
    expect(await notifications('saved_search_paused')).toEqual([
      {
        entity_id: flatSearch.id,
        params: { savedSearchId: flatSearch.id, name: 'Cheap flat nearby', idleDays: '30' },
      },
    ]);

    // A paused search matches nothing.
    await post('Flat, cheap, new', '10000.00', 89.25);
    await runMatcher();
    expect(
      (await call<SavedSearch>('GET', `/saved-searches/${flatSearch.id}`, 'owner')).body
        .newResultCount,
    ).toBe(0);

    // Its slot is free now: another search takes it, and then resuming is refused.
    const filler = await call<SavedSearch>('POST', '/saved-searches', 'owner', {
      name: 'Filler',
      center: CENTER,
      radius_km: 1,
      frequency: 'off',
    });
    expect(filler.status).toBe(201);
    expect(
      (await call('PATCH', `/saved-searches/${flatSearch.id}`, 'owner', { active: true })).status,
    ).toBe(409);
    expect((await call('DELETE', `/saved-searches/${filler.body.id}`, 'owner')).status).toBe(204);
    const resumed = await call<SavedSearch>('PATCH', `/saved-searches/${flatSearch.id}`, 'owner', {
      active: true,
    });
    expect(resumed.body).toMatchObject({ active: true, pausedAt: null });
  }, 30_000);

  it('serves unmet demand to tenant admins only', async () => {
    // A search that found nothing, from a located searcher.
    await app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: {
        q: 'duplex penthouse',
        category: 'saved-e2e-flats',
        lat: String(CENTER.lat),
        lng: String(CENTER.lng),
      },
      headers: { 'x-tenant-id': TENANT, 'x-install-id': 'saved-e2e-install' },
    });
    await worker.get(UnmetDemandService).refresh();

    const report = await call<UnmetDemand>('GET', '/analytics/unmet-demand', 'admin');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ resultThreshold: 3, windowDays: 30 });
    expect(report.body.rows).toEqual(
      expect.arrayContaining([
        {
          category: {
            id: CATEGORY,
            slug: 'saved-e2e-flats',
            name: { bn: 'তালিকা', en: 'Listings' },
          },
          geoArea: { id: AREA, name: { bn: 'সেভড', en: 'Saved E2E' } },
          activeSavedSearches: 1,
          weakSearches: 1,
        },
      ]),
    );
    expect((await call('GET', '/analytics/unmet-demand', 'owner')).status).toBe(403);
  });
});

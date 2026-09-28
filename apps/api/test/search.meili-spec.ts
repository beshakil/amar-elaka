import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PinoLogger } from 'nestjs-pino';
import {
  parseFieldSchema,
  parseUiSchema,
  type CategoryFieldDefinition,
} from '../src/categories/field-schema';
import { loadDotenv } from '../src/config/load-dotenv';
import type { DatabaseTransaction } from '../src/database/database.client';
import { TenantContext } from '../src/database/tenant-context';
import type { TenantDb } from '../src/database/tenant-db';
import {
  placeDocument,
  postDocument,
  storeDocument,
  type PostRow,
} from '../src/search/documents/document-builder';
import {
  searchQuerySchema,
  suggestQuerySchema,
  type SearchResponse,
} from '../src/search/dto/search.dto';
import { MeilisearchEngine } from '../src/search/engine/meilisearch-engine';
import { buildIndexSettings } from '../src/search/index-settings';
import {
  matchForms,
  type SearchActivityService,
} from '../src/search/query/search-activity.service';
import type { SearchQueryRepository } from '../src/search/query/search-query.repository';
import { SearchCriteriaService } from '../src/search/query/search-criteria.service';
import { SearchMatcher } from '../src/search/query/search-matcher';
import { SearchService } from '../src/search/query/search.service';
import {
  SearchCategoryNotShippableException,
  SearchCursorInvalidException,
} from '../src/search/search.exceptions';
import { indexUid, SEARCH_TYPES, type SearchDocument } from '../src/search/search.types';
import { SYNONYM_LINES } from '../src/search/synonyms/search-synonyms.generated';
import { toMeilisearchSynonyms } from '../src/search/synonyms/synonym-dictionary';
import { SearchTerms } from '../src/search/text/search-terms';
import type { SettingsService } from '../src/settings/settings.service';
import type { StorageService } from '../src/storage/storage.ports';

/**
 * Search against a REAL Meilisearch (`pnpm --filter @amar-elaka/api test:search`,
 * MEILI_HOST / MEILI_MASTER_KEY from the environment or .env). Everything on
 * the search path is production code — documents from the document builder,
 * the index settings and synonym dictionary, SearchService's query expansion,
 * filters, facets and ranking; only Postgres is replaced by fixed rows.
 *
 * The headline requirement: "ডাক্তার", "daktar", "doctor" and "dakter" all
 * find the same doctor listing.
 */

loadDotenv();

const PREFIX = `test_${Date.now()}_`;
const TENANT_A = '0191e3a0-8181-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-8181-7000-8000-00000000000b';

// Mirpur 10, Dhaka, and points around it.
const MIRPUR = { lat: 23.8069, lng: 90.3687 };
const NEAR_MIRPUR = { lat: 23.8103, lng: 90.3712 }; // ~450 m
const ACROSS_BORDER = { lat: 23.828, lng: 90.3642 }; // ~2.4 km, another tenant
const GAZIPUR = { lat: 23.9999, lng: 90.4203 }; // ~22 km

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../packages/dynamic-form/fixtures/to-let.json'), 'utf8'),
) as {
  fieldSchema: {
    jsonSchema: unknown;
    uiSchema: unknown;
    filterableFields: string[];
    searchableFields: string[];
  };
};

const toLetDefinition: CategoryFieldDefinition = {
  jsonSchema: parseFieldSchema(fixture.fieldSchema.jsonSchema),
  uiSchema: parseUiSchema(fixture.fieldSchema.uiSchema),
  filterableFields: fixture.fieldSchema.filterableFields,
  searchableFields: fixture.fieldSchema.searchableFields,
  analyticsFields: [],
};

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

function post(id: string, title: string, over: Partial<PostRow> = {}): PostRow {
  return {
    id,
    tenant_id: TENANT_A,
    title,
    description: null,
    price: null,
    category_id: 'cat-doctors',
    category_slug: 'doctors',
    category_name_bn: 'ডাক্তার ও চেম্বার',
    category_name_en: 'Doctors',
    locality_id: null,
    area_name_bn: 'মিরপুর',
    area_name_en: 'Mirpur',
    lat: MIRPUR.lat,
    lng: MIRPUR.lng,
    published_at: NOW - 30 * DAY,
    is_boosted: false,
    is_shippable: false,
    cover_thumb_key: null,
    cover_thumbhash: null,
    rating_avg: null,
    json_schema: null,
    ui_schema: null,
    filterable_fields: [],
    searchable_fields: [],
    fields: {},
    ...over,
  };
}

function rental(
  id: string,
  title: string,
  fields: Record<string, unknown>,
  over: Partial<PostRow> = {},
) {
  return post(id, title, {
    category_id: 'cat-to-let',
    category_slug: 'to-let',
    category_name_bn: 'টু-লেট / বাসা ভাড়া',
    category_name_en: 'To-Let / House Rent',
    json_schema: toLetDefinition.jsonSchema,
    ui_schema: toLetDefinition.uiSchema,
    filterable_fields: toLetDefinition.filterableFields,
    searchable_fields: toLetDefinition.searchableFields,
    price: typeof fields.price === 'string' ? fields.price : null,
    fields,
    ...over,
  });
}

const tutor = (id: string, name: string, over: Partial<PostRow>) =>
  post(id, name, {
    category_id: 'cat-tutors',
    category_slug: 'tutors',
    category_name_bn: 'শিক্ষক',
    category_name_en: 'Teachers',
    area_name_bn: null,
    area_name_en: null,
    ...over,
  });

const ROWS: PostRow[] = [
  post('doctor-bn', 'ডাক্তার আনিসুর রহমান — মেডিসিন বিশেষজ্ঞ'),
  post('doctor-en', "Dr. Rahim's Chamber", { lat: NEAR_MIRPUR.lat, lng: NEAR_MIRPUR.lng }),
  post('doctor-other-tenant', 'ডাক্তার সেলিনা আক্তার', { tenant_id: TENANT_B, ...ACROSS_BORDER }),
  post('electrician', 'ইলেকট্রিশিয়ান করিম মিয়া', {
    category_id: 'cat-services',
    category_slug: 'home-services',
    category_name_bn: 'ঘরের কাজ',
    category_name_en: 'Home services',
  }),
  rental('basa', 'মিরপুরে ২ রুমের বাসা ভাড়া', {
    property_type: 'flat',
    tenant_type: 'family',
    bedrooms: 2,
    price: '15000.00',
    available_from: '2026-10-01',
  }),
  rental('flat-en', 'Uttara 3 bed flat for rent', {
    property_type: 'flat',
    tenant_type: 'bachelor_male',
    bedrooms: 3,
    price: '25000.00',
    available_from: '2026-11-01',
  }),
  rental(
    'house-far',
    'বাড়ি ভাড়া দেওয়া হবে',
    {
      property_type: 'house',
      tenant_type: 'family',
      bedrooms: 4,
      price: '40000.00',
      available_from: '2026-10-15',
    },
    GAZIPUR,
  ),
  post('generator-note', 'Flat in Mirpur 2', {
    description: 'চমৎকার জেনারেটর ব্যাকআপ আছে',
    category_id: 'cat-misc',
    category_slug: 'misc',
    category_name_bn: 'অন্যান্য',
    category_name_en: 'Other',
  }),
  post('cow', 'কোরবানির গরু বিক্রি', {
    category_id: 'cat-livestock',
    category_slug: 'livestock',
    category_name_bn: 'গবাদি পশু',
    category_name_en: 'Livestock',
  }),
  // Ranking: identical text except the typo; they differ only in boost, distance and age.
  tutor('rank-boosted', 'Math tutor', {
    is_boosted: true,
    ...GAZIPUR,
    published_at: NOW - 60 * DAY,
  }),
  tutor('rank-near', 'Math tutor', { ...NEAR_MIRPUR, published_at: NOW - 60 * DAY }),
  tutor('rank-recent', 'Math tutor', { ...GAZIPUR, published_at: NOW - DAY }),
  tutor('rank-old', 'Math tutor', { ...GAZIPUR, published_at: NOW - 60 * DAY }),
  tutor('rank-typo', 'Math tuter', { is_boosted: true, ...NEAR_MIRPUR, published_at: NOW }),
];

const SETTINGS: Record<string, number> = {
  search_default_radius_km: 10,
  search_max_radius_km: 50,
  search_page_size_default: 20,
  search_page_size_max: 50,
  search_max_total_hits: 1000,
  search_suggest_min_chars: 2,
  search_suggest_categories_max: 3,
  search_suggest_queries_max: 3,
  search_suggest_listings_max: 5,
  search_facet_fields_max: 4,
  search_price_bucket_count: 5,
  search_landmarks_max: 3,
};

/** Popular queries of tenant A, as search_popular_queries would rank them. */
const POPULAR = ['ডাক্তার চেম্বার', 'daktar', 'basa vara', 'কোরবানির গরু'];

describe('Search against a real Meilisearch', () => {
  const HOST = process.env.MEILI_HOST ?? 'http://127.0.0.1:7700';
  const KEY = process.env.MEILI_MASTER_KEY ?? '';
  const engine = new MeilisearchEngine({
    MEILI_HOST: HOST,
    MEILI_MASTER_KEY: KEY,
    MEILI_TIMEOUT_MS: 10_000,
  });
  const terms = new SearchTerms(SYNONYM_LINES);
  let service: SearchService;
  let matcher: SearchMatcher;
  let criteria: SearchCriteriaService;

  beforeAll(async () => {
    const settings = buildIndexSettings(
      toMeilisearchSynonyms(SYNONYM_LINES, [['মিরপুর ১০', 'Mirpur 10', 'mirpur-10']]),
      { oneTypoMinChars: 4, twoTyposMinChars: 8, facetValuesMax: 100, maxTotalHits: 1000 },
    );
    for (const type of SEARCH_TYPES) {
      await engine.ensureIndex(indexUid(PREFIX, type));
      await engine.updateSettings(indexUid(PREFIX, type), settings);
    }
    await engine.upsertDocuments(
      indexUid(PREFIX, 'posts'),
      ROWS.map((row) => postDocument(row, terms)),
    );
    await engine.upsertDocuments(indexUid(PREFIX, 'places'), [
      placeDocument(
        {
          ...post('landmark-hospital', 'unused'),
          name_bn: 'মিরপুর ডাক্তার হাসপাতাল',
          name_en: 'Mirpur Doctors Hospital',
          slug: 'mirpur-hospital',
          is_landmark: true,
          ...NEAR_MIRPUR,
        },
        terms,
      ),
      placeDocument(
        {
          ...post('not-landmark', 'unused'),
          name_bn: 'ডাক্তার ফার্মেসি কর্নার',
          name_en: null,
          slug: 'pharmacy-corner',
          is_landmark: false,
        },
        terms,
      ),
    ]);
    await engine.upsertDocuments(indexUid(PREFIX, 'stores'), [
      storeDocument(
        {
          ...post('store-pharmacy', 'unused'),
          name_bn: 'রহিম ফার্মেসি',
          name_en: 'Rahim Pharmacy',
          slug: 'rahim-pharmacy',
          is_verified: true,
        },
        terms,
      ),
    ]);

    const context = new TenantContext();
    jest
      .spyOn(context, 'require')
      .mockReturnValue({ tenantId: TENANT_A, role: 'anonymous' } as never);
    const repo = {
      resolveCategory: (_tx: DatabaseTransaction, slug: string) =>
        Promise.resolve(
          slug === 'to-let'
            ? {
                id: 'cat-to-let',
                slug: 'to-let',
                ids: ['cat-to-let'],
                shippableIds: [],
                definition: toLetDefinition,
              }
            : slug === 'livestock'
              ? {
                  id: 'cat-livestock',
                  slug: 'livestock',
                  ids: ['cat-livestock'],
                  shippableIds: ['cat-livestock'],
                  definition: null,
                }
              : undefined,
        ),
      tenantCategories: () =>
        Promise.resolve([{ slug: 'doctors', name_bn: 'ডাক্তার ও চেম্বার', name_en: 'Doctors' }]),
      // Tenant A's map centre: where search is centred when the query has no location.
      tenantCenter: () => Promise.resolve(MIRPUR),
    } as unknown as SearchQueryRepository;
    const activity = {
      log: () => Promise.resolve('0191e3a0-0000-7000-8000-00000000000f'),
      cached: <T>(_tenant: string, _key: string, load: () => Promise<T>) => load(),
      popularPool: () => Promise.resolve(POPULAR.map((q) => ({ query: q, forms: matchForms(q) }))),
    } as unknown as SearchActivityService;
    const settingsService = {
      get: (key: string) => Promise.resolve(SETTINGS[key]),
    } as unknown as SettingsService;
    const tenantDb = {
      transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
        work({} as DatabaseTransaction),
    } as unknown as TenantDb;
    matcher = new SearchMatcher(engine, { MEILI_INDEX_PREFIX: PREFIX });
    criteria = new SearchCriteriaService(repo, settingsService, tenantDb);
    service = new SearchService(
      engine,
      matcher,
      criteria,
      repo,
      activity,
      settingsService,
      tenantDb,
      context,
      {
        getPublicUrl: (_b: string, key: string) => `https://cdn.test/${key}`,
      } as unknown as StorageService,
      { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger,
    );
  }, 120_000);

  afterAll(async () => {
    for (const type of SEARCH_TYPES) await engine.deleteIndex(indexUid(PREFIX, type));
  }, 60_000);

  const search = (input: Record<string, unknown>) => service.search(searchQuerySchema.parse(input));
  const ids = (response: SearchResponse) => response.hits.map((h) => h.id);

  describe('ডাক্তার / daktar / doctor / dakter', () => {
    const variants = ['ডাক্তার', 'daktar', 'doctor', 'dakter'];

    it.each(variants)('"%s" finds the doctor listing', async (q) => {
      const response = await search({ q });
      expect(response.degraded).toBe(false);
      expect(ids(response)).toContain('doctor-bn');
    });

    it('all four return the same listings: every doctor within the default radius, across the boundary', async () => {
      const results = await Promise.all(
        variants.map(async (q) => new Set(ids(await search({ q })))),
      );
      // §13.26: without a location, search is a radius around the tenant's centre, so
      // the doctor 2.4 km away in tenant B is found too; Gazipur (22 km) is not.
      for (const result of results) {
        expect(result).toEqual(new Set(['doctor-bn', 'doctor-en', 'doctor-other-tenant']));
      }
    });

    it.each(['ডাকতার', 'ডক্টর', 'daktor', 'doktor', 'DOCTOR', 'Dr', 'doctr'])(
      'misspellings and variants also work: "%s"',
      async (q) => {
        expect(ids(await search({ q }))).toContain('doctor-bn');
      },
    );

    it('a Bengali query finds a listing written in English', async () => {
      expect(ids(await search({ q: 'ডাক্তার রহিম' }))[0]).toBe('doctor-en');
    });
  });

  it.each([
    'electrician',
    'ইলেকট্রিশিয়ান',
    'ইলেক্ট্রিশিয়ান',
    'ilektrishiyan',
    'electrishian',
    'ইলেকট্রিশিয়ন',
  ])('electrician in any script or spelling: "%s"', async (q) => {
    expect(ids(await search({ q }))).toContain('electrician');
  });

  it.each(['basa', 'basha', 'বাসা', 'house', 'বাড়ি', 'basa vara', 'bari bhara'])(
    'rentals in any script: "%s"',
    async (q) => {
      expect(ids(await search({ q }))).toEqual(expect.arrayContaining(['basa']));
    },
  );

  it('ranks exact match > boosted > nearby > recent', async () => {
    const response = await search({
      q: 'tutor',
      lat: MIRPUR.lat,
      lng: MIRPUR.lng,
      scope: 'nearby',
      radius_km: 50,
    });
    expect(ids(response)).toEqual([
      'rank-boosted',
      'rank-near',
      'rank-recent',
      'rank-old',
      'rank-typo',
    ]);
  });

  it('with a location, searches by radius across tenants, nearest first, with distances', async () => {
    const near = await search({
      q: 'doctor',
      lat: MIRPUR.lat,
      lng: MIRPUR.lng,
      scope: 'nearby',
      radius_km: 5,
    });
    expect(new Set(ids(near))).toEqual(new Set(['doctor-bn', 'doctor-en', 'doctor-other-tenant']));
    expect(near.hits.find((h) => h.id === 'doctor-other-tenant')?.distanceMeters).toBeGreaterThan(
      2000,
    );

    // Without a location it is still a radius (around tenant A's centre), so the
    // other tenant's doctor is found — but no hit carries a distance, since the
    // centre isn't where the viewer is.
    const noLocation = await search({ q: 'doctor' });
    expect(ids(noLocation)).toContain('doctor-other-tenant');
    expect(noLocation.hits.every((h) => h.distanceMeters === null)).toBe(true);

    // A smaller radius leaves out the far rental.
    const rentals = await search({
      category: 'to-let',
      lat: MIRPUR.lat,
      lng: MIRPUR.lng,
      scope: 'nearby',
      radius_km: 10,
    });
    expect(ids(rentals)).not.toContain('house-far');
  });

  it('filters on custom fields and returns facets for the filter UI', async () => {
    // Wide enough to include the far house: this test is about field filters, not geo.
    const wide = { lat: MIRPUR.lat, lng: MIRPUR.lng, scope: 'nearby', radius_km: 50 };
    const all = await search({ ...wide, category: 'to-let' });
    expect(new Set(ids(all))).toEqual(new Set(['basa', 'flat-en', 'house-far']));
    expect(all.facets.fields.property_type).toEqual({
      kind: 'values',
      values: [
        { value: 'flat', count: 2 },
        { value: 'house', count: 1 },
      ],
    });
    expect(all.facets.fields.price).toEqual({ kind: 'range', min: '15000.00', max: '40000.00' });
    expect(all.facets.fields.bedrooms).toEqual({ kind: 'range', min: 2, max: 4 });

    const bigAndCheap = await search({
      ...wide,
      category: 'to-let',
      filters: JSON.stringify({ bedrooms: { gte: 3 }, price: { lt: '30000' } }),
    });
    expect(ids(bigAndCheap)).toEqual(['flat-en']);

    const houses = await search({
      ...wide,
      category: 'to-let',
      filters: JSON.stringify({ property_type: { in: ['house'] } }),
    });
    expect(ids(houses)).toEqual(['house-far']);

    const cheapestFirst = await search({ ...wide, category: 'to-let', sort: 'price_asc' });
    expect(cheapestFirst.hits.map((h) => h.price)).toEqual(['15000.00', '25000.00', '40000.00']);
  });

  it('searches select-option labels in both languages ("ফ্ল্যাট" finds an English listing)', async () => {
    expect(ids(await search({ q: 'ফ্ল্যাট' }))).toEqual(
      expect.arrayContaining(['basa', 'flat-en']),
    );
  });

  it('finds a Bengali word that appears only in the description', async () => {
    expect(ids(await search({ q: 'চমৎকার' }))).toEqual(['generator-note']);
    expect(ids(await search({ q: 'জেনারেটর ব্যাকআপ' }))).toContain('generator-note');
  });

  it('searches stores too', async () => {
    const response = await search({ q: 'ফার্মেসি', type: 'stores' });
    expect(response.hits[0]).toMatchObject({
      id: 'store-pharmacy',
      slug: 'rahim-pharmacy',
      isVerified: true,
    });
    expect(ids(await search({ q: 'pharmacy', type: 'stores' }))).toEqual(['store-pharmacy']);
  });

  it('suggests as you type: categories, popular queries and listing titles, in any script', async () => {
    for (const q of ['dak', 'ডাক', 'doctor']) {
      const response = await service.suggest(suggestQuerySchema.parse({ q }));
      expect(response.degraded).toBe(false);
      expect(response.categories[0]).toMatchObject({ slug: 'doctors' });
      // "ডাক্তার চেম্বার" and "daktar" are both popular; each script finds both.
      expect(response.queries.map((x) => x.query)).toEqual(['ডাক্তার চেম্বার', 'daktar']);
      expect(response.listings.map((l) => l.id)).toEqual(
        expect.arrayContaining(['doctor-bn', 'doctor-en']),
      );
      expect(response.listings.length).toBeLessThanOrEqual(5);
    }
  });

  it("answers a suggestion's listing queries well within the 50 ms budget, engine side", async () => {
    // Engine processing time, as Meilisearch reports it: the wall clock inside
    // Jest adds ~45 ms of test-runtime HTTP overhead that a server doesn't have
    // (the same request takes ~10 ms from a plain Node process). The service's
    // own share is measured in search.service.spec.ts.
    const request = (q: string) => ({
      indexUid: indexUid(PREFIX, 'posts'),
      q,
      limit: 5,
      filter: [`_geoRadius(${MIRPUR.lat}, ${MIRPUR.lng}, 10000)`],
      sort: [`_geoPoint(${MIRPUR.lat}, ${MIRPUR.lng}):asc`],
    });
    for (const typed of [['ডাক্তা', 'dakta'], ['doc'], ['basa v']]) {
      const response = await fetch(`${HOST}/multi-search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: typed.map(request) }),
      });
      const { results } = (await response.json()) as { results: { processingTimeMs: number }[] };
      const total = results.reduce((sum, r) => sum + r.processingTimeMs, 0);
      expect(total).toBeLessThan(25);
    }
  });

  it('pages with a cursor bound to the search, and never repeats a hit', async () => {
    const first = await search({ q: 'tutor', scope: 'nearby', radius_km: 50, limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await search({
      q: 'tutor',
      scope: 'nearby',
      radius_km: 50,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.page).toBe(2);
    expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);
    // The same cursor with another query is refused, not silently mixed.
    await expect(
      search({ q: 'doctor', scope: 'nearby', radius_km: 50, limit: 2, cursor: first.nextCursor }),
    ).rejects.toThrow(SearchCursorInvalidException);
  });

  it('returns price ranges as a facet, counted exactly, ignoring the price filter itself', async () => {
    const wide = { lat: MIRPUR.lat, lng: MIRPUR.lng, scope: 'nearby', radius_km: 50 };
    const all = await search({ ...wide, category: 'to-let' });
    expect(all.facets.price).toEqual({
      min: '15000.00',
      max: '40000.00',
      buckets: [
        { min: '10000.00', max: '20000.00', count: 1 },
        { min: '20000.00', max: '30000.00', count: 1 },
        { min: '30000.00', max: '40000.00', count: 0 },
        { min: '40000.00', max: null, count: 1 },
      ],
    });

    // Choosing a range filters the hits, but the facet still shows every range.
    const cheap = await search({
      ...wide,
      category: 'to-let',
      price_min: '20000',
      price_max: '30000',
    });
    expect(ids(cheap)).toEqual(['flat-en']);
    expect(cheap.facets.price?.buckets.map((b) => b.count)).toEqual([1, 1, 0, 1]);
  });

  it("limits the chosen category's value facets to its top select-type fields", async () => {
    const one = await service.search(
      searchQuerySchema.parse({ category: 'to-let', scope: 'nearby', radius_km: 50, ...MIRPUR }),
    );
    // to-let has two select fields (property_type, tenant_type), both within 4.
    expect(Object.keys(one.facets.fields)).toEqual(
      expect.arrayContaining(['property_type', 'tenant_type']),
    );
  });

  it('sorts by distance (and still accepts the old "nearest")', async () => {
    for (const sort of ['distance', 'nearest']) {
      const response = await search({
        q: 'doctor',
        sort,
        scope: 'nearby',
        radius_km: 5,
        ...MIRPUR,
      });
      const distances = response.hits.map((h) => h.distanceMeters!);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    }
  });

  it('shows matching landmarks above a text search, never plain places', async () => {
    const response = await search({ q: 'ডাক্তার', ...MIRPUR });
    expect(response.landmarks.map((l) => l.id)).toEqual(['landmark-hospital']);
    expect(response.landmarks[0]).toMatchObject({ type: 'places', isLandmark: true });
    // Not on a category page.
    expect((await search({ q: 'ডাক্তার', category: 'to-let', ...MIRPUR })).landmarks).toEqual([]);
  });

  it('country scope: shippable categories only, with no radius', async () => {
    await engine.upsertDocuments(indexUid(PREFIX, 'posts'), [
      postDocument(
        post('cow-far', 'কোরবানির গরু বিক্রি — দিনাজপুর', {
          category_id: 'cat-livestock',
          category_slug: 'livestock',
          lat: 25.62,
          lng: 88.63,
          is_shippable: true,
        }),
        terms,
      ),
    ]);
    const nationwide = await search({ q: 'গরু', scope: 'country' });
    expect(nationwide).toMatchObject({ scope: 'country', radiusKm: null });
    // 'cow' is in a category that doesn't ship; the Dinajpur cow is 300 km away but ships.
    expect(ids(nationwide)).toEqual(['cow-far']);
    expect(ids(await search({ q: 'গরু' }))).toEqual(['cow']);
    await expect(search({ category: 'to-let', scope: 'country' })).rejects.toThrow(
      SearchCategoryNotShippableException,
    );
    await engine.deleteDocuments(indexUid(PREFIX, 'posts'), ['cow-far']);
  });

  it('removes deleted documents', async () => {
    const extra: SearchDocument = postDocument(post('temp', 'ডাক্তার অস্থায়ী'), terms);
    await engine.upsertDocuments(indexUid(PREFIX, 'posts'), [extra]);
    expect(ids(await search({ q: 'অস্থায়ী' }))).toEqual(['temp']);
    await engine.deleteDocuments(indexUid(PREFIX, 'posts'), ['temp']);
    expect(ids(await search({ q: 'অস্থায়ী' }))).toEqual([]);
  });
});

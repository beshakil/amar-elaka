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
import type { SearchQueryRepository } from '../src/search/query/search-query.repository';
import { SearchService } from '../src/search/query/search.service';
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
  search_suggest_limit: 8,
};

describe('Search against a real Meilisearch', () => {
  const engine = new MeilisearchEngine({
    MEILI_HOST: process.env.MEILI_HOST ?? 'http://127.0.0.1:7700',
    MEILI_MASTER_KEY: process.env.MEILI_MASTER_KEY ?? '',
    MEILI_TIMEOUT_MS: 10_000,
  });
  const terms = new SearchTerms(SYNONYM_LINES);
  let service: SearchService;

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
            ? { id: 'cat-to-let', ids: ['cat-to-let'], definition: toLetDefinition }
            : undefined,
        ),
      tenantCategories: () =>
        Promise.resolve([{ slug: 'doctors', name_bn: 'ডাক্তার ও চেম্বার', name_en: 'Doctors' }]),
    } as unknown as SearchQueryRepository;
    service = new SearchService(
      engine,
      repo,
      { get: (key: string) => Promise.resolve(SETTINGS[key]) } as unknown as SettingsService,
      {
        transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
          work({} as DatabaseTransaction),
      } as unknown as TenantDb,
      context,
      {
        getPublicUrl: (_b: string, key: string) => `https://cdn.test/${key}`,
      } as unknown as StorageService,
      { MEILI_INDEX_PREFIX: PREFIX },
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

    it('all four return the same listings: both doctors of this tenant, nothing else', async () => {
      const results = await Promise.all(
        variants.map(async (q) => new Set(ids(await search({ q })))),
      );
      for (const result of results) expect(result).toEqual(new Set(['doctor-bn', 'doctor-en']));
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
    const response = await search({ q: 'tutor', lat: MIRPUR.lat, lng: MIRPUR.lng, radius: 50 });
    expect(ids(response)).toEqual([
      'rank-boosted',
      'rank-near',
      'rank-recent',
      'rank-old',
      'rank-typo',
    ]);
  });

  it('with a location, searches by radius across tenants, nearest first, with distances', async () => {
    const near = await search({ q: 'doctor', lat: MIRPUR.lat, lng: MIRPUR.lng, radius: 5 });
    expect(new Set(ids(near))).toEqual(new Set(['doctor-bn', 'doctor-en', 'doctor-other-tenant']));
    expect(near.hits.find((h) => h.id === 'doctor-other-tenant')?.distanceMeters).toBeGreaterThan(
      2000,
    );

    // Without a location, the other tenant's doctor stays out.
    expect(ids(await search({ q: 'doctor' }))).not.toContain('doctor-other-tenant');

    // A smaller radius leaves out the far rental.
    const rentals = await search({
      category: 'to-let',
      lat: MIRPUR.lat,
      lng: MIRPUR.lng,
      radius: 10,
    });
    expect(ids(rentals)).not.toContain('house-far');
  });

  it('filters on custom fields and returns facets for the filter UI', async () => {
    const all = await search({ category: 'to-let' });
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
      category: 'to-let',
      filters: JSON.stringify({ bedrooms: { gte: 3 }, price: { lt: '30000' } }),
    });
    expect(ids(bigAndCheap)).toEqual(['flat-en']);

    const houses = await search({
      category: 'to-let',
      filters: JSON.stringify({ property_type: { in: ['house'] } }),
    });
    expect(ids(houses)).toEqual(['house-far']);

    const cheapestFirst = await search({ category: 'to-let', sort: 'price_asc' });
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

  it('suggests as you type, in Banglish too', async () => {
    const response = await service.suggest(suggestQuerySchema.parse({ q: 'dak' }));
    expect(response.suggestions[0]).toMatchObject({ kind: 'category', slug: 'doctors' });
    expect(response.suggestions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'posts', id: 'doctor-bn' })]),
    );
  });

  it('removes deleted documents', async () => {
    const extra: SearchDocument = postDocument(post('temp', 'ডাক্তার অস্থায়ী'), terms);
    await engine.upsertDocuments(indexUid(PREFIX, 'posts'), [extra]);
    expect(ids(await search({ q: 'অস্থায়ী' }))).toEqual(['temp']);
    await engine.deleteDocuments(indexUid(PREFIX, 'posts'), ['temp']);
    expect(ids(await search({ q: 'অস্থায়ী' }))).toEqual([]);
  });
});

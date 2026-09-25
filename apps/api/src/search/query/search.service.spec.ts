import type { PinoLogger } from 'nestjs-pino';
import type { FieldSchema, UiSchema } from '../../categories/field-schema';
import { InvalidFieldFilterException } from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import type { TenantDb } from '../../database/tenant-db';
import type { SettingsService } from '../../settings/settings.service';
import type { StorageService } from '../../storage/storage.ports';
import { searchQuerySchema, suggestQuerySchema } from '../dto/search.dto';
import {
  SearchRequestRejectedError,
  SearchUnavailableError,
  type EngineSearchRequest,
  type EngineSearchResult,
  type SearchEngine,
} from '../engine/search-engine.port';
import {
  SearchCategoryNotFoundException,
  SearchFiltersNeedFieldsException,
} from '../search.exceptions';
import type { SearchDocument } from '../search.types';
import type {
  FallbackQuery,
  FallbackRow,
  ResolvedCategory,
  SearchQueryRepository,
} from './search-query.repository';
import { poishaToMoney, SearchService } from './search.service';

const TENANT = '0191e3a0-7171-7000-8000-000000000001';
const SETTINGS: Record<string, number> = {
  search_default_radius_km: 10,
  search_max_radius_km: 50,
  search_page_size_default: 20,
  search_page_size_max: 50,
  search_max_total_hits: 1000,
  search_suggest_min_chars: 2,
  search_suggest_limit: 8,
};

const toLet: ResolvedCategory = {
  id: 'c-to-let',
  ids: ['c-to-let', 'c-sublet'],
  definition: {
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        bedrooms: { 'x-field-type': 'number', type: 'integer' },
        price: { 'x-field-type': 'money', type: 'string' },
        property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'house'] },
      },
    } as unknown as FieldSchema,
    uiSchema: { order: [], card: [], labels: {} } as unknown as UiSchema,
    filterableFields: ['bedrooms', 'price', 'property_type'],
    searchableFields: [],
    analyticsFields: [],
  },
};

function doc(over: Partial<SearchDocument> = {}): SearchDocument & { _geoDistance?: number } {
  return {
    id: 'p1',
    tenant_id: TENANT,
    name_bn: 'ডাক্তার রহিম',
    name_en: null,
    name_translit: 'daktar rohim',
    name_variants: [],
    description: null,
    field_text: null,
    text_translit: null,
    category_id: 'c-doc',
    category_slug: 'doctors',
    category_name_bn: 'ডাক্তার',
    category_name_en: 'Doctors',
    category_translit: 'daktar',
    locality_id: null,
    area_name_bn: 'মিরপুর',
    area_name_en: 'Mirpur',
    area_translit: 'mirpur',
    _geo: { lat: 23.8, lng: 90.36 },
    is_boosted: 1,
    published_at: 1_790_000_000,
    fields: {},
    card_fields: { fee: '500.00' },
    price_minor: 1_250_050,
    rating_avg: null,
    slug: null,
    cover_thumb_key: 't/image/k.thumb.webp',
    cover_thumbhash: 'hash',
    is_verified: false,
    is_landmark: false,
    ...over,
  };
}

class FakeEngine implements Partial<SearchEngine> {
  requests: EngineSearchRequest[] = [];
  fail: Error | null = null;
  result: EngineSearchResult<SearchDocument> = {
    hits: [doc({ _geoDistance: 420 } as Partial<SearchDocument>)],
    estimatedTotalHits: 1,
    facetDistribution: {
      category_slug: { doctors: 1, clinics: 3 },
      'fields.property_type': { flat: 7, house: 2 },
    },
    facetStats: {
      'fields.price': { min: 800_000, max: 2_500_050 },
      'fields.bedrooms': { min: 1, max: 4 },
    },
  };

  search = <T extends object>(request: EngineSearchRequest): Promise<EngineSearchResult<T>> => {
    this.requests.push(request);
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(this.result as unknown as EngineSearchResult<T>);
  };

  multiSearch = <T extends object>(
    requests: EngineSearchRequest[],
  ): Promise<EngineSearchResult<T>[]> => {
    this.requests.push(...requests);
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(
      requests.map((r) => ({
        hits: [doc({ id: `${r.indexUid}-1` })],
        estimatedTotalHits: 1,
        facetDistribution: {},
        facetStats: {},
      })) as unknown as EngineSearchResult<T>[],
    );
  };
}

class FakeRepo implements Partial<SearchQueryRepository> {
  fallbackQueries: FallbackQuery[] = [];
  resolveCategory = (_tx: DatabaseTransaction, slug: string) =>
    Promise.resolve(
      slug === 'to-let' ? toLet : slug === 'doctors' ? { ...toLet, definition: null } : undefined,
    );
  tenantCategories = () =>
    Promise.resolve([
      { slug: 'doctors', name_bn: 'ডাক্তার', name_en: 'Doctors' },
      { slug: 'to-let', name_bn: 'টু-লেট', name_en: 'To-Let' },
    ]);
  fallback = (
    _tx: DatabaseTransaction,
    _type: string,
    query: FallbackQuery,
  ): Promise<FallbackRow[]> => {
    this.fallbackQueries.push(query);
    return Promise.resolve([
      {
        id: 'db1',
        tenant_id: TENANT,
        name_bn: 'ডাক্তার রহিম',
        name_en: null,
        description: null,
        category_id: null,
        category_slug: null,
        category_name_bn: null,
        category_name_en: null,
        lat: null,
        lng: null,
        distance_m: null,
        published_at: new Date('2026-09-01T00:00:00Z'),
        price: '500.00',
        slug: null,
      },
    ]);
  };
}

function setup() {
  const engine = new FakeEngine();
  const repo = new FakeRepo();
  const context = new TenantContext();
  jest.spyOn(context, 'require').mockReturnValue({ tenantId: TENANT, role: 'anonymous' } as never);
  const tenantDb = {
    transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
      work({} as DatabaseTransaction),
  } as unknown as TenantDb;
  const settings = {
    get: (key: string) => Promise.resolve(SETTINGS[key]),
  } as unknown as SettingsService;
  const storage = {
    getPublicUrl: (_b: string, key: string) => `https://cdn.test/${key}`,
  } as unknown as StorageService;
  const logger = { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger;
  const service = new SearchService(
    engine as unknown as SearchEngine,
    repo as unknown as SearchQueryRepository,
    settings,
    tenantDb,
    context,
    storage,
    { MEILI_INDEX_PREFIX: 'test_' },
    logger,
  );
  return { service, engine, repo };
}

const query = (input: Record<string, unknown>) => searchQuerySchema.parse(input);

describe('SearchService.search', () => {
  it('queries the tenant with the expanded query and maps hits for the API', async () => {
    const { service, engine } = setup();
    const response = await service.search(query({ q: 'ডাক্তার' }));

    expect(engine.requests[0]).toMatchObject({
      indexUid: 'test_posts',
      q: 'daktar ডাক্তার',
      filter: [`tenant_id = "${TENANT}"`],
      sort: [],
      facets: ['category_slug'],
      limit: 20,
      offset: 0,
    });
    expect(response.degraded).toBe(false);
    expect(response.hits[0]).toMatchObject({
      id: 'p1',
      name: { bn: 'ডাক্তার রহিম', en: null },
      price: '12500.50',
      isBoosted: true,
      distanceMeters: 420,
      publishedAt: new Date(1_790_000_000_000).toISOString(),
      cover: { thumbUrl: 'https://cdn.test/t/image/k.thumb.webp', thumbhash: 'hash' },
      cardFields: { fee: '500.00' },
    });
    expect(response.facets.categories).toEqual([
      { slug: 'clinics', count: 3 },
      { slug: 'doctors', count: 1 },
    ]);
  });

  it('searches by radius across tenants when given a location, capping the radius', async () => {
    const { service, engine } = setup();
    await service.search(query({ q: 'doctor', lat: 23.8, lng: 90.4, radius: 500 }));
    expect(engine.requests[0]!.filter).toEqual(['_geoRadius(23.8, 90.4, 50000)']);
    expect(engine.requests[0]!.sort).toEqual(['_geoPoint(23.8, 90.4):asc']);

    await service.search(query({ q: 'doctor', lat: 23.8, lng: 90.4 }));
    expect(engine.requests[1]!.filter).toEqual(['_geoRadius(23.8, 90.4, 10000)']);
  });

  it('filters by category (with its children) and custom fields, and returns field facets', async () => {
    const { service, engine } = setup();
    const response = await service.search(
      query({
        category: 'to-let',
        filters: JSON.stringify({
          bedrooms: { gte: 2 },
          price: { lt: '20000' },
          property_type: { in: ['flat'] },
        }),
      }),
    );
    expect(engine.requests[0]!.filter).toEqual([
      `tenant_id = "${TENANT}"`,
      'category_id IN ["c-to-let", "c-sublet"]',
      'fields.bedrooms >= 2',
      'fields.price < 2000000',
      'fields.property_type IN ["flat"]',
    ]);
    expect(engine.requests[0]!.facets).toEqual([
      'category_slug',
      'fields.bedrooms',
      'fields.price',
      'fields.property_type',
    ]);
    expect(response.facets.fields).toEqual({
      bedrooms: { kind: 'range', min: 1, max: 4 },
      price: { kind: 'range', min: '8000.00', max: '25000.50' },
      property_type: {
        kind: 'values',
        values: [
          { value: 'flat', count: 7 },
          { value: 'house', count: 2 },
        ],
      },
    });
  });

  it('refuses unknown categories and invalid filters', async () => {
    const { service } = setup();
    await expect(service.search(query({ category: 'nope' }))).rejects.toThrow(
      SearchCategoryNotFoundException,
    );
    await expect(
      service.search(query({ category: 'doctors', filters: '{"x":{"eq":"1"}}' })),
    ).rejects.toThrow(SearchFiltersNeedFieldsException);
    await expect(
      service.search(query({ category: 'to-let', filters: '{"bedrooms":{"eq":"many"}}' })),
    ).rejects.toThrow(InvalidFieldFilterException);
  });

  it('pages, and stops at search_max_total_hits without calling the engine', async () => {
    const { service, engine } = setup();
    await service.search(query({ page: 3, limit: 10 }));
    expect(engine.requests[0]).toMatchObject({ limit: 10, offset: 20 });
    const deep = await service.search(query({ page: 21, limit: 50 }));
    expect(deep.hits).toEqual([]);
    expect(engine.requests).toHaveLength(1);
  });

  it('answers from Postgres when Meilisearch is down, expanding the query through the dictionary', async () => {
    const { service, engine, repo } = setup();
    engine.fail = new SearchUnavailableError();
    const response = await service.search(query({ q: 'daktar' }));

    expect(response.degraded).toBe(true);
    expect(response.hits[0]).toMatchObject({
      id: 'db1',
      price: '500.00',
      nameTranslit: 'daktar rohim',
    });
    expect(repo.fallbackQueries[0]!.terms).toEqual(
      expect.arrayContaining(['daktar', 'doctor', 'ডাক্তার']),
    );

    // The breaker is open: the next request skips the engine entirely.
    await service.search(query({ q: 'doctor' }));
    expect(engine.requests).toHaveLength(1);
    expect(repo.fallbackQueries).toHaveLength(2);
  });

  it('does not hide engine rejections (a bad request is a bug, not an outage)', async () => {
    const { service, engine } = setup();
    engine.fail = new SearchRequestRejectedError('invalid_search_filter', 'bad filter');
    await expect(service.search(query({ q: 'x' }))).rejects.toThrow(SearchRequestRejectedError);
  });
});

describe('SearchService.suggest', () => {
  it('suggests matching categories (in any script) before listings from all three indexes', async () => {
    const { service, engine } = setup();
    const response = await service.suggest(suggestQuerySchema.parse({ q: 'doctor' }));
    expect(response.suggestions[0]).toEqual({
      kind: 'category',
      slug: 'doctors',
      name: { bn: 'ডাক্তার', en: 'Doctors' },
    });
    expect(response.suggestions.slice(1).map((s) => s.kind)).toEqual(['posts', 'stores', 'places']);
    expect(engine.requests.map((r) => r.indexUid)).toEqual([
      'test_posts',
      'test_stores',
      'test_places',
    ]);

    const banglish = await service.suggest(suggestQuerySchema.parse({ q: 'dak' }));
    expect(banglish.suggestions[0]).toMatchObject({ kind: 'category', slug: 'doctors' });
  });

  it('waits for enough characters, and falls back to categories only when the engine is down', async () => {
    const { service, engine } = setup();
    expect((await service.suggest(suggestQuerySchema.parse({ q: 'd' }))).suggestions).toEqual([]);
    engine.fail = new SearchUnavailableError();
    const response = await service.suggest(suggestQuerySchema.parse({ q: 'টু' }));
    expect(response).toMatchObject({
      degraded: true,
      suggestions: [{ kind: 'category', slug: 'to-let' }],
    });
  });
});

describe('poishaToMoney', () => {
  it('formats integer poisha exactly', () => {
    expect(poishaToMoney(0)).toBe('0.00');
    expect(poishaToMoney(5)).toBe('0.05');
    expect(poishaToMoney(1_500_000)).toBe('15000.00');
    expect(poishaToMoney(999_999_999_999)).toBe('9999999999.99');
  });
});

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
  SearchCategoryNotShippableException,
  SearchCursorInvalidException,
  SearchFiltersNeedFieldsException,
} from '../search.exceptions';
import {
  matchForms,
  type SearchActivityService,
  type SearchLogEntry,
} from './search-activity.service';
import type { SearchDocument } from '../search.types';
import type {
  FallbackQuery,
  FallbackRow,
  ResolvedCategory,
  SearchQueryRepository,
} from './search-query.repository';
import { SearchCriteriaService } from './search-criteria.service';
import { SearchMatcher } from './search-matcher';
import { poishaToMoney, SearchService, topFacetFields } from './search.service';

const TENANT = '0191e3a0-7171-7000-8000-000000000001';
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
// Date.now() is frozen at this instant, so the expiry filter the matcher adds is fixed (0049).
const NOW_MS = 1_790_000_000_000;
const LISTED = '(expires_at NOT EXISTS OR expires_at IS NULL OR expires_at > 1790000000)';
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW_MS));
afterEach(() => jest.restoreAllMocks());

const SIGNALS = { userId: undefined, installId: undefined, ip: '203.0.113.9', userAgent: 'test' };

const toLet: ResolvedCategory = {
  id: 'c-to-let',
  slug: 'to-let',
  ids: ['c-to-let', 'c-sublet'],
  shippableIds: [],
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
    is_shippable: false,
    published_at: 1_790_000_000,
    expires_at: null,
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
      requests.map((r, i) => ({
        hits: r.countOnly ? [] : [doc({ id: `${r.indexUid}-1` })],
        estimatedTotalHits: r.countOnly ? 10 + i : 1,
        facetDistribution: {},
        facetStats: {},
      })) as unknown as EngineSearchResult<T>[],
    );
  };
}

// The tenant's map centre: where discovery is centred without a viewer location.
const CENTER = { lat: 23.81, lng: 90.41 };

class FakeRepo implements Partial<SearchQueryRepository> {
  fallbackQueries: FallbackQuery[] = [];
  tenantCenter = () => Promise.resolve(CENTER);
  openIdsQueries: { entity: string; radiusKm: number }[] = [];
  openIds: string[] = [];
  openStates = (_tx: DatabaseTransaction, _entity: string, ids: readonly string[]) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [id, { state: 'open' as const, changesAt: '2026-10-09T15:00:00.000Z' }]),
      ),
    );
  openIdsNear = (
    _tx: DatabaseTransaction,
    entity: 'store' | 'place',
    _origin: { lat: number; lng: number },
    radiusKm: number,
  ) => {
    this.openIdsQueries.push({ entity, radiusKm });
    return Promise.resolve(this.openIds);
  };
  resolveCategory = (_tx: DatabaseTransaction, slug: string) =>
    Promise.resolve(
      slug === 'to-let'
        ? toLet
        : slug === 'doctors'
          ? { ...toLet, definition: null }
          : slug === 'books'
            ? {
                id: 'c-books',
                slug: 'books',
                ids: ['c-books', 'c-old'],
                shippableIds: ['c-books'],
                definition: null,
              }
            : undefined,
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
  const logged: SearchLogEntry[] = [];
  const activity = {
    log: (entry: SearchLogEntry) => {
      logged.push(entry);
      return Promise.resolve('0191e3a0-0000-7000-8000-0000000000aa');
    },
    cached: <T>(_tenant: string, _key: string, load: () => Promise<T>) => load(),
    popularPool: () =>
      Promise.resolve(
        ['ডাক্তার চেম্বার', 'daktar', 'doctor near me', 'টু-লেট'].map((q) => ({
          query: q,
          forms: matchForms(q),
        })),
      ),
  } as unknown as SearchActivityService;
  // The real shared matcher and criteria service, over the fakes: what the
  // saved-search matcher uses too (ADR 041).
  const matcher = new SearchMatcher(engine as unknown as SearchEngine, {
    MEILI_INDEX_PREFIX: 'test_',
  });
  const criteria = new SearchCriteriaService(
    repo as unknown as SearchQueryRepository,
    settings,
    tenantDb,
  );
  const service = new SearchService(
    engine as unknown as SearchEngine,
    matcher,
    criteria,
    repo as unknown as SearchQueryRepository,
    activity,
    settings,
    tenantDb,
    context,
    storage,
    logger,
  );
  return { service, engine, repo, logged };
}

const query = (input: Record<string, unknown>) => searchQuerySchema.parse(input);

describe('SearchService.search', () => {
  it("searches around the tenant's centre without a location, and maps hits for the API", async () => {
    const { service, engine } = setup();
    const response = await service.search(query({ q: 'ডাক্তার' }));

    expect(engine.requests[0]).toMatchObject({
      indexUid: 'test_posts',
      q: 'daktar ডাক্তার',
      // §13.26: radius, never a tenant filter.
      filter: [LISTED, '_geoRadius(23.81, 90.41, 10000)'],
      sort: ['_geoPoint(23.81, 90.41):asc'],
      // Posts: the price bounds come with the page.
      facets: ['category_slug', 'price_minor'],
      limit: 20,
      offset: 0,
    });
    expect(response.degraded).toBe(false);
    expect(response.hits[0]).toMatchObject({
      id: 'p1',
      name: { bn: 'ডাক্তার রহিম', en: null },
      price: '12500.50',
      isBoosted: true,
      // Measured from the tenant's centre, not the viewer: meaningless to them.
      distanceMeters: null,
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
    const main = () => engine.requests.filter((r) => r.indexUid === 'test_posts' && !r.countOnly);
    await service.search(
      query({ q: 'doctor', lat: 23.8, lng: 90.4, scope: 'nearby', radius_km: 500 }),
    );
    expect(main()[0]!.filter).toEqual([LISTED, '_geoRadius(23.8, 90.4, 50000)']);
    expect(main()[0]!.sort).toEqual(['_geoPoint(23.8, 90.4):asc']);

    // The area scope ignores radius_km, exactly like the feed.
    await service.search(query({ q: 'doctor', lat: 23.8, lng: 90.4, radius_km: 3 }));
    expect(main()[1]!.filter).toEqual([LISTED, '_geoRadius(23.8, 90.4, 10000)']);

    const located = await service.search(query({ q: 'doctor', lat: 23.8, lng: 90.4 }));
    expect(located.hits[0]!.distanceMeters).toBe(420);
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
      LISTED,
      '_geoRadius(23.81, 90.41, 10000)',
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
      'price_minor',
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

  it('pages (legacy page=), and stops at search_max_total_hits without calling the engine', async () => {
    const { service, engine } = setup();
    await service.search(query({ page: 3, limit: 10 }));
    expect(engine.requests[0]).toMatchObject({ limit: 10, offset: 20 });
    const deep = await service.search(query({ page: 21, limit: 50 }));
    expect(deep.hits).toEqual([]);
    expect(engine.requests.filter((r) => r.limit === 50)).toHaveLength(0);
  });

  it('pages by cursor: the next offset, bound to the same search', async () => {
    const { service, engine } = setup();
    engine.result = { ...engine.result, hits: [doc(), doc({ id: 'p2' })], estimatedTotalHits: 5 };
    const first = await service.search(query({ q: 'x', limit: 2 }));
    expect(first.nextCursor).not.toBeNull();
    const second = await service.search(query({ q: 'x', limit: 2, cursor: first.nextCursor }));
    expect(engine.requests.at(-1)).toMatchObject({ offset: 2, limit: 2 });
    expect(second.page).toBe(2);
    await expect(
      service.search(query({ q: 'y', limit: 2, cursor: first.nextCursor })),
    ).rejects.toThrow(SearchCursorInvalidException);
    await expect(service.search(query({ q: 'x', limit: 2, cursor: 'bm9wZQ' }))).rejects.toThrow(
      SearchCursorInvalidException,
    );

    // The last page has no next cursor.
    engine.result = { ...engine.result, estimatedTotalHits: 2 };
    expect((await service.search(query({ q: 'x', limit: 2 }))).nextCursor).toBeNull();
  });

  it('country scope: no radius, shippable categories only; refuses a category that never ships', async () => {
    const { service, engine } = setup();
    const response = await service.search(
      query({ q: 'book', scope: 'country', category: 'books' }),
    );
    expect(response).toMatchObject({ scope: 'country', radiusKm: null });
    expect(engine.requests[0]!.filter).toEqual([
      LISTED,
      'is_shippable = true',
      'category_id IN ["c-books"]',
    ]);
    await expect(service.search(query({ scope: 'country', category: 'to-let' }))).rejects.toThrow(
      SearchCategoryNotShippableException,
    );
  });

  it('filters by price and returns price ranges counted without the price filter', async () => {
    const { service, engine } = setup();
    engine.result = {
      ...engine.result,
      facetStats: { price_minor: { min: 1_500_000, max: 4_000_000 } },
    };
    const response = await service.search(
      query({ q: 'flat', price_min: '20000', price_max: '30000.5' }),
    );
    expect(engine.requests[0]!.filter).toEqual([
      LISTED,
      '_geoRadius(23.81, 90.41, 10000)',
      'price_minor >= 2000000',
      'price_minor < 3000050',
    ]);
    // The bounds come from a second query without the price filter.
    expect(engine.requests[1]).toMatchObject({
      filter: [LISTED, '_geoRadius(23.81, 90.41, 10000)'],
      limit: 0,
    });
    const counts = engine.requests.filter((r) => r.countOnly);
    expect(counts.map((r) => r.filter!.slice(2))).toEqual([
      ['price_minor >= 1000000', 'price_minor < 2000000'],
      ['price_minor >= 2000000', 'price_minor < 3000000'],
      ['price_minor >= 3000000', 'price_minor < 4000000'],
      ['price_minor >= 4000000'],
    ]);
    expect(response.facets.price).toEqual({
      min: '15000.00',
      max: '40000.00',
      buckets: [
        { min: '10000.00', max: '20000.00', count: 10 },
        { min: '20000.00', max: '30000.00', count: 11 },
        { min: '30000.00', max: '40000.00', count: 12 },
        { min: '40000.00', max: null, count: 13 },
      ],
    });
  });

  it('an explicit sort of a text search selects by text, then sorts purely', async () => {
    const { service, engine } = setup();
    engine.result = { ...engine.result, hits: [doc({ id: 'a' }), doc({ id: 'b' })] };
    await service.search(query({ q: 'flat', sort: 'price_asc' }));
    // 1: the ids matching every word, within the same scope.
    expect(engine.requests[0]).toMatchObject({
      q: 'flat',
      matchingStrategy: 'all',
      attributesToRetrieve: ['id'],
      limit: 1000,
      filter: [LISTED, '_geoRadius(23.81, 90.41, 10000)'],
    });
    // 2: a placeholder search over those ids, sorted by price.
    expect(engine.requests[1]).toMatchObject({
      q: '',
      filter: [LISTED, '_geoRadius(23.81, 90.41, 10000)', 'id IN ["a", "b"]'],
      sort: ['price_minor:asc', '_geoPoint(23.81, 90.41):asc'],
    });

    // Relevance, or no text: one query, as before.
    engine.requests = [];
    await service.search(query({ q: 'flat' }));
    await service.search(query({ sort: 'price_asc' }));
    expect(engine.requests.some((r) => r.matchingStrategy === 'all')).toBe(false);

    // Nothing matches every word: an empty page, no second query.
    engine.requests = [];
    engine.result = { ...engine.result, hits: [] };
    const none = await service.search(query({ q: 'zzz', sort: 'newest' }));
    expect(none.hits).toEqual([]);
    expect(engine.requests).toHaveLength(1);
  });

  it('looks up landmarks on the first page of a text search only', async () => {
    const { service, engine } = setup();
    const response = await service.search(query({ q: 'hospital', lat: 23.8, lng: 90.4 }));
    const landmarkQuery = engine.requests.find((r) => r.indexUid === 'test_places');
    expect(landmarkQuery).toMatchObject({
      filter: [LISTED, '_geoRadius(23.8, 90.4, 10000)', 'is_landmark = true'],
      limit: 3,
    });
    expect(response.landmarks[0]).toMatchObject({ type: 'places' });

    engine.requests = [];
    await service.search(query({ q: 'hospital', category: 'doctors' }));
    await service.search(query({ q: '' }));
    await service.search(query({ q: 'hospital', page: 2 }));
    expect(engine.requests.some((r) => r.indexUid === 'test_places')).toBe(false);
  });

  it('logs the first page of a text search: normalized text, a filters digest, the total', async () => {
    const { service, logged } = setup();
    const response = await service.search(query({ q: '  DAKTAR   Rahim ' }), SIGNALS);
    expect(response.searchId).toBe('0191e3a0-0000-7000-8000-0000000000aa');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      tenantId: TENANT,
      qNormalized: 'daktar rahim',
      resultCount: 1,
      signals: SIGNALS,
    });
    expect(logged[0]!.filtersHash).toMatch(/^[0-9a-f]{16}$/);

    // Same filters, same digest; another category, another digest.
    await service.search(query({ q: 'x' }), SIGNALS);
    await service.search(query({ q: 'x', category: 'doctors' }), SIGNALS);
    expect(logged[1]!.filtersHash).toBe(logged[0]!.filtersHash);
    expect(logged[2]!.filtersHash).not.toBe(logged[0]!.filtersHash);

    // Not logged: browsing without text, later pages.
    await service.search(query({ q: '' }), SIGNALS);
    const later = await service.search(query({ q: 'x', page: 2 }), SIGNALS);
    expect(later.searchId).toBeNull();
    expect(logged).toHaveLength(3);
  });

  it('does not log degraded searches (their counts cover one tenant only)', async () => {
    const { service, engine, logged } = setup();
    engine.fail = new SearchUnavailableError();
    const response = await service.search(query({ q: 'daktar' }), SIGNALS);
    expect(response).toMatchObject({ degraded: true, searchId: null });
    expect(logged).toEqual([]);
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
    const before = engine.requests.length;
    await service.search(query({ q: 'doctor' }));
    expect(engine.requests).toHaveLength(before);
    expect(repo.fallbackQueries).toHaveLength(2);
  });

  it('does not hide engine rejections (a bad request is a bug, not an outage)', async () => {
    const { service, engine } = setup();
    engine.fail = new SearchRequestRejectedError('invalid_search_filter', 'bad filter');
    await expect(service.search(query({ q: 'x' }))).rejects.toThrow(SearchRequestRejectedError);
  });
});

describe('SearchService.suggest', () => {
  it('suggests categories, popular queries and top listing titles, in any script', async () => {
    const { service, engine } = setup();
    const response = await service.suggest(suggestQuerySchema.parse({ q: 'doctor' }));
    expect(response.categories).toEqual([
      { slug: 'doctors', name: { bn: 'ডাক্তার', en: 'Doctors' } },
    ]);
    // "doctor" is a synonym of ডাক্তার/daktar, so all three scripts' popular queries match.
    expect(response.queries.map((q) => q.query)).toEqual([
      'ডাক্তার চেম্বার',
      'daktar',
      'doctor near me',
    ]);
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]).toMatchObject({
      indexUid: 'test_posts',
      limit: 5,
      filter: [LISTED, '_geoRadius(23.81, 90.41, 10000)'],
    });
    expect(response.listings[0]).toEqual({
      id: 'test_posts-1',
      tenantId: TENANT,
      title: { bn: 'ডাক্তার রহিম', en: null },
      categorySlug: 'doctors',
    });

    // Half-typed Bengali goes as itself and as Banglish: each is a prefix query.
    engine.requests = [];
    await service.suggest(suggestQuerySchema.parse({ q: 'ডাক' }));
    expect(engine.requests.map((r) => r.q)).toEqual(['ডাক', 'dak']);

    for (const q of ['dak', 'ডাক']) {
      const typed = await service.suggest(suggestQuerySchema.parse({ q }));
      expect(typed.categories[0]).toMatchObject({ slug: 'doctors' });
      expect(typed.queries.map((x) => x.query)).toEqual(['ডাক্তার চেম্বার', 'daktar']);
    }
  });

  it('costs well under a millisecond per keystroke apart from the engine (500 popular queries)', async () => {
    const { service } = setup();
    const pool = Array.from({ length: 500 }, (_, i) =>
      i % 2 ? `query number ${i}` : `ডাক্তার খোঁজ ${i}`,
    ).map((q) => ({ query: q, forms: matchForms(q) }));
    (
      service as unknown as { activity: { popularPool: () => Promise<unknown> } }
    ).activity.popularPool = () => Promise.resolve(pool);
    const q = suggestQuerySchema.parse({ q: 'ডাক্তা' });
    await service.suggest(q);
    const runs = 50;
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) await service.suggest(q);
    expect((performance.now() - started) / runs).toBeLessThan(5);
  });

  it('never suggests exactly what was typed', async () => {
    const { service } = setup();
    const response = await service.suggest(suggestQuerySchema.parse({ q: 'daktar' }));
    expect(response.queries.map((q) => q.query)).toEqual(['ডাক্তার চেম্বার', 'doctor near me']);
  });

  it('waits for enough characters, and leaves listings out when the engine is down', async () => {
    const { service, engine } = setup();
    expect(await service.suggest(suggestQuerySchema.parse({ q: 'd' }))).toMatchObject({
      categories: [],
      queries: [],
      listings: [],
    });
    engine.fail = new SearchUnavailableError();
    const response = await service.suggest(suggestQuerySchema.parse({ q: 'টু' }));
    expect(response).toMatchObject({
      degraded: true,
      categories: [{ slug: 'to-let' }],
      queries: [{ query: 'টু-লেট' }],
      listings: [],
    });
  });
});

describe('topFacetFields', () => {
  it('keeps the first N select-type fields and every range field', () => {
    const definition = {
      ...toLet.definition!,
      jsonSchema: {
        ...toLet.definition!.jsonSchema,
        properties: {
          ...toLet.definition!.jsonSchema.properties,
          furnished: { 'x-field-type': 'bool', type: 'boolean' },
          facing: { 'x-field-type': 'select', type: 'string', enum: ['north'] },
        },
      } as unknown as FieldSchema,
      filterableFields: ['property_type', 'bedrooms', 'furnished', 'price', 'facing'],
    };
    expect(topFacetFields(definition, 2)).toEqual([
      'property_type',
      'bedrooms',
      'furnished',
      'price',
    ]);
    expect(topFacetFields(definition, 0)).toEqual(['bedrooms', 'price']);
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

describe('SearchService.search — open_now (ADR 049)', () => {
  it('limits stores to the open ids near the origin and gives each hit its open state', async () => {
    const { service, engine, repo } = setup();
    repo.openIds = ['s-open-1', 's-open-2'];
    const response = await service.search(query({ type: 'stores', open_now: 'true' }));
    expect(repo.openIdsQueries).toEqual([{ entity: 'store', radiusKm: 10 }]);
    expect(engine.requests[0]!.filter).toContain('id IN ["s-open-1", "s-open-2"]');
    expect(response.hits[0]!.openState).toEqual({
      state: 'open',
      changesAt: '2026-10-09T15:00:00.000Z',
    });
  });

  it('answers empty without asking the engine when nothing is open', async () => {
    const { service, engine, repo } = setup();
    repo.openIds = [];
    const response = await service.search(query({ type: 'places', open_now: 'true' }));
    expect(response.hits).toEqual([]);
    expect(engine.requests).toHaveLength(0);
  });

  it('posts have no opening hours: open_now is refused for them, and their hits carry no state', async () => {
    expect(() => query({ type: 'posts', open_now: 'true' })).toThrow(/open_now applies/);
    const { service } = setup();
    const response = await service.search(query({ q: 'ডাক্তার' }));
    expect(response.hits[0]!.openState).toBeNull();
  });
});

import type { PinoLogger } from 'nestjs-pino';
import type { AnalyticsTracker } from '../../analytics/seller/analytics-tracker.service';
import type { FieldSchema, UiSchema } from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import type { TenantDb } from '../../database/tenant-db';
import type { SearchActivityService } from '../../search/query/search-activity.service';
import { searchQuerySchema } from '../../search/dto/search.dto';
import type {
  EngineSearchRequest,
  EngineSearchResult,
  SearchEngine,
} from '../../search/engine/search-engine.port';
import { SearchCriteriaService } from '../../search/query/search-criteria.service';
import { SearchMatcher } from '../../search/query/search-matcher';
import type {
  ResolvedCategory,
  SearchQueryRepository,
} from '../../search/query/search-query.repository';
import { SearchService } from '../../search/query/search.service';
import type { SettingsService } from '../../settings/settings.service';
import type { StorageService } from '../../storage/storage.ports';
import type { StoredSavedSearch } from '../saved-search-criteria';
import type { NewPost, SavedSearchesRepository } from '../saved-searches.repository';
import { SavedSearchMatcherService } from './saved-search-matcher.service';

const TENANT = '0191e3a0-7171-7000-8000-000000000001';
const CENTER = { lat: 23.8, lng: 90.4 };

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
      },
    } as unknown as FieldSchema,
    uiSchema: { order: [], card: [], labels: {} } as unknown as UiSchema,
    filterableFields: ['bedrooms'],
    searchableFields: [],
    analyticsFields: [],
  },
};

/** An engine that "matches" the ids in `accept`, within each request's `id IN [...]`. */
class FakeEngine implements Partial<SearchEngine> {
  requests: EngineSearchRequest[] = [];
  accept = new Set<string>();

  private hits(request: EngineSearchRequest) {
    const within = (request.filter ?? [])
      .find((f) => f.startsWith('id IN '))
      ?.match(/"([^"]+)"/g)
      ?.map((q) => q.slice(1, -1));
    const ids = (within ?? [...this.accept]).filter((id) => this.accept.has(id));
    return {
      hits: ids.map((id) => ({ id })),
      estimatedTotalHits: ids.length,
      facetDistribution: {},
      facetStats: {},
    };
  }

  search = <T extends object>(request: EngineSearchRequest): Promise<EngineSearchResult<T>> => {
    this.requests.push(request);
    return Promise.resolve(this.hits(request) as unknown as EngineSearchResult<T>);
  };

  multiSearch = <T extends object>(requests: EngineSearchRequest[]) => {
    this.requests.push(...requests);
    return Promise.resolve(requests.map((r) => this.hits(r)) as unknown as EngineSearchResult<T>[]);
  };
}

const SETTINGS: Record<string, number> = {
  search_default_radius_km: 10,
  search_max_radius_km: 50,
  search_page_size_default: 20,
  search_page_size_max: 50,
  search_max_total_hits: 1000,
  search_facet_fields_max: 4,
  search_price_bucket_count: 0,
  search_landmarks_max: 0,
};

function stored(over: Partial<StoredSavedSearch> = {}): StoredSavedSearch {
  return {
    id: 's-flat',
    user_id: 'u1',
    name: 'Flat',
    query_text: 'flat',
    category_id: 'c-to-let',
    category_slug: 'to-let',
    filters: { fields: { bedrooms: { gte: 2 } } },
    price_min: '10000.00',
    price_max: null,
    lat: CENTER.lat,
    lng: CENTER.lng,
    radius_km: 5,
    alert_frequency_code: 'instant',
    is_active: true,
    paused_at: null,
    last_alerted_at: null,
    last_engaged_at: null,
    notify_day: null,
    notify_count: 0,
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function setup(searches: StoredSavedSearch[], pairs: { search_id: string; post_id: string }[]) {
  const engine = new FakeEngine();
  const searchRepo = {
    resolveCategory: () => Promise.resolve(toLet),
    resolveCategoryById: (_tx: DatabaseTransaction, id: string) =>
      Promise.resolve(id === 'c-to-let' ? toLet : undefined),
    tenantCenter: () => Promise.resolve(CENTER),
  } as unknown as SearchQueryRepository;
  const settings = {
    get: (key: string) => Promise.resolve(SETTINGS[key]),
  } as unknown as SettingsService;
  const tenantDb = {
    transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
      work({} as DatabaseTransaction),
  } as unknown as TenantDb;
  const context = new TenantContext();
  const warn = jest.fn();
  const logger = { setContext: () => undefined, warn } as unknown as PinoLogger;
  // The shared pieces, real: one SearchMatcher and one SearchCriteriaService for both.
  const matcher = new SearchMatcher(engine as unknown as SearchEngine, {
    MEILI_INDEX_PREFIX: 'test_',
  });
  const criteria = new SearchCriteriaService(searchRepo, settings, tenantDb);

  const posts: NewPost[] = [
    { id: 'p1', tenant_id: TENANT, published_at: new Date('2026-09-28T00:00:00Z') },
    { id: 'p2', tenant_id: TENANT, published_at: new Date('2026-09-28T00:01:00Z') },
    { id: 'p3', tenant_id: TENANT, published_at: new Date('2026-09-28T00:02:00Z') },
  ];
  const inserted: unknown[] = [];
  const watermarks: string[] = [];
  const repo = {
    matchableTenants: () => Promise.resolve([TENANT]),
    ensureWatermark: () => Promise.resolve(),
    newPosts: jest.fn().mockResolvedValueOnce(posts).mockResolvedValue([]),
    candidatePairs: () => Promise.resolve(pairs),
    loadForMatching: () => Promise.resolve(searches),
    insertMatches: (_tx: DatabaseTransaction, rows: unknown[]) => {
      inserted.push(...rows);
      return Promise.resolve(rows.length);
    },
    advanceWatermark: (_tx: DatabaseTransaction, _tenant: string, last: NewPost) => {
      watermarks.push(last.id);
      return Promise.resolve();
    },
  } as unknown as SavedSearchesRepository;

  const service = new SavedSearchMatcherService(
    repo,
    criteria,
    matcher,
    settings,
    tenantDb,
    context,
    logger,
  );
  const search = new SearchService(
    engine as unknown as SearchEngine,
    matcher,
    criteria,
    searchRepo,
    {} as SearchActivityService,
    settings,
    tenantDb,
    context,
    {} as StorageService,
    logger,
    { searchAppearances: () => undefined } as unknown as AnalyticsTracker,
  );
  jest.spyOn(context, 'require').mockReturnValue({ tenantId: TENANT, role: 'anon' } as never);
  return { service, search, engine, matcher, inserted, watermarks, warn, repo };
}

describe('SavedSearchMatcherService', () => {
  // Frozen, so the expiry filter the matcher adds (0049) is a fixed string.
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000));
  afterEach(() => jest.restoreAllMocks());

  it('decides matches through the shared SearchMatcher, only among each search’s candidates', async () => {
    const { service, engine, matcher, inserted, watermarks } = setup(
      [stored()],
      [
        { search_id: 's-flat', post_id: 'p1' },
        { search_id: 's-flat', post_id: 'p2' },
      ],
    );
    const matchEach = jest.spyOn(matcher, 'matchEach');
    engine.accept = new Set(['p2', 'p3']); // p3 matches too, but is not near the search

    const outcome = await service.matchNewPosts({ batchSize: 50, maxBatches: 5 });

    expect(matchEach).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([
      { searchId: 's-flat', userId: 'u1', postId: 'p2', postTenantId: TENANT },
    ]);
    expect(watermarks).toEqual(['p3']);
    expect(outcome).toEqual({ rows: 3, capped: false, details: { matches: 1 } });
  });

  it('skips a tenant deleted mid-run and carries on with the others', async () => {
    const { service, engine, watermarks, warn, repo } = setup(
      [stored()],
      [{ search_id: 's-flat', post_id: 'p1' }],
    );
    engine.accept = new Set(['p1']);
    // What Drizzle throws for Postgres 23503: the driver's error as the cause.
    const fkViolation = Object.assign(new Error('Failed query'), { cause: { code: '23503' } });
    Object.assign(repo, {
      matchableTenants: () => Promise.resolve(['t-gone', TENANT]),
      ensureWatermark: (_tx: DatabaseTransaction, tenantId: string) =>
        tenantId === 't-gone' ? Promise.reject(fkViolation) : Promise.resolve(),
    });

    const outcome = await service.matchNewPosts({ batchSize: 50, maxBatches: 5 });

    expect(watermarks).toEqual(['p3']);
    expect(outcome).toMatchObject({ rows: 3, capped: false });
    expect(warn).toHaveBeenCalledWith(
      { tenantId: 't-gone' },
      'tenant or post deleted during matching; skipped',
    );

    // Anything else still fails the run: the next one retries it.
    Object.assign(repo, { ensureWatermark: () => Promise.reject(new Error('connection lost')) });
    await expect(service.matchNewPosts({ batchSize: 50, maxBatches: 5 })).rejects.toThrow(
      'connection lost',
    );
  });

  it('sends the engine exactly what GET /search sends for the same criteria', async () => {
    const { service, search, engine } = setup([stored()], [{ search_id: 's-flat', post_id: 'p1' }]);
    engine.accept = new Set(['p1']);
    await service.matchNewPosts({ batchSize: 50, maxBatches: 5 });
    const fromSavedSearch = engine.requests.at(-1)!;

    engine.requests = [];
    // Only the requests matter here; the fake's bare {id} hits don't map to cards.
    await search
      .search(
        searchQuerySchema.parse({
          q: 'flat',
          category: 'to-let',
          filters: JSON.stringify({ bedrooms: { gte: 2 } }),
          price_min: '10000',
          lat: String(CENTER.lat),
          lng: String(CENTER.lng),
          scope: 'nearby',
          radius_km: '5',
          // An explicit sort: the list is the text matches, then pure order.
          sort: 'newest',
        }),
      )
      .catch(() => undefined);
    const selection = engine.requests.find((r) => r.matchingStrategy === 'all')!;
    const page = engine.requests.find((r) => r.q === '' && r.limit === 20)!;

    // Same text, same strategy.
    expect(fromSavedSearch.q).toBe(selection.q);
    expect(fromSavedSearch.matchingStrategy).toBe('all');
    // Same filters, price included: everything but the final `id IN [...]`.
    expect(fromSavedSearch.filter!.slice(0, -1)).toEqual(page.filter!.slice(0, -1));
    expect(fromSavedSearch.filter).toEqual([
      '(expires_at NOT EXISTS OR expires_at IS NULL OR expires_at > 1790000000)',
      '_geoRadius(23.8, 90.4, 5000)',
      'category_id IN ["c-to-let", "c-sublet"]',
      'fields.bedrooms >= 2',
      'price_minor >= 1000000',
      'id IN ["p1"]',
    ]);
  });

  it('skips a search whose filters no longer fit its category, never half-matching it', async () => {
    const { service, engine, inserted, warn } = setup(
      [stored({ id: 'broken', filters: { fields: { gone_field: { eq: 'x' } } } }), stored()],
      [
        { search_id: 'broken', post_id: 'p1' },
        { search_id: 's-flat', post_id: 'p1' },
      ],
    );
    engine.accept = new Set(['p1']);
    await service.matchNewPosts({ batchSize: 50, maxBatches: 5 });
    expect(inserted).toEqual([
      { searchId: 's-flat', userId: 'u1', postId: 'p1', postTenantId: TENANT },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ savedSearchId: 'broken' }),
      'saved search no longer resolves; skipped',
    );
  });

  it('stops at the run budget and says so', async () => {
    const { service } = setup([], []);
    const outcome = await service.matchNewPosts({ batchSize: 3, maxBatches: 1 });
    expect(outcome.capped).toBe(true);
  });
});

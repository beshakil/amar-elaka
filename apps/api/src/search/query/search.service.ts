import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { CategoryFieldDefinition } from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantNotFoundException, TenantRequiredException } from '../../database/tenant.exceptions';
import { TenantDb } from '../../database/tenant-db';
import type { ViewerSignals } from '../../engagement/viewer-key';
import { SettingsService } from '../../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/storage.ports';
import type { OpenState } from '../../hours/open-state';
import type {
  PriceFacet,
  SearchHit,
  SearchQuery,
  SearchResponse,
  SearchScope,
  SuggestQuery,
  SuggestResponse,
} from '../dto/search.dto';
import {
  SEARCH_ENGINE,
  SearchUnavailableError,
  type EngineSearchResult,
  type SearchEngine,
} from '../engine/search-engine.port';
import type { SearchDocument, SearchType } from '../search.types';
import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { toMeilisearchSynonyms } from '../synonyms/synonym-dictionary';
import { hasBengali, normalizeSearchText, searchWords } from '../text/normalize';
import { transliterate, transliterateWord } from '../text/transliterate';
import { buildSort, idsIn, priceExpressions } from './filter-builder';
import { priceBuckets } from './price-buckets';
import { matchForms, SearchActivityService } from './search-activity.service';
import { SearchCriteriaService } from './search-criteria.service';
import { SearchMatcher, type SearchCriteria } from './search-matcher';
import { decodeSearchCursor, encodeSearchCursor, searchDigest } from './search-cursor';
import {
  SearchQueryRepository,
  type FallbackRow,
  type ResolvedArea,
  type ResolvedCategory,
} from './search-query.repository';

// settings-exempt: circuit-breaker window after the engine fails (resilience tuning): requests skip straight to Postgres meanwhile
const ENGINE_COOLDOWN_MS = 10_000;
// settings-exempt: bounds the ILIKE alternatives of a degraded query (query cost), not a business rule
const FALLBACK_MAX_TERMS = 24;
const POISHA_PER_TAKA = 100; // settings-exempt: currency unit conversion
const MONEY_DECIMALS = 2; // settings-exempt: the scale of numeric(12,2), a column type
const MILLIS_PER_SECOND = 1_000; // settings-exempt: unit conversion
const MONEY_FIELD_TYPES = new Set(['money']);
const RANGE_FIELD_TYPES = new Set(['number', 'money', 'date']);
/** "Select-type" fields: a small set of values, faceted as value counts. */
const VALUE_FIELD_TYPES = new Set(['select', 'multiselect', 'bool']);
const PRICE_ATTRIBUTE = 'price_minor';

/** Integer poisha → "12000.00" without ever going through a float. */
export function poishaToMoney(poisha: number): string {
  const whole = Math.trunc(poisha / POISHA_PER_TAKA);
  const fraction = Math.abs(poisha % POISHA_PER_TAKA);
  return `${whole}.${String(fraction).padStart(MONEY_DECIMALS, '0')}`;
}

function yyyymmddToDate(value: number): string {
  return String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
}

interface Plan {
  tenantId: string;
  type: SearchType;
  q: string;
  /** normalizeSearchText(q): what is logged, never the raw text. */
  qNormalized: string;
  scope: SearchScope;
  /** Where "nearby" and distance are measured from: the viewer, else the tenant's centre. */
  origin: { lat: number; lng: number };
  /** Null in the country scope: no radius. */
  radiusKm: number | null;
  /** False when origin is the tenant's centre, not the viewer: distances then mean nothing to them. */
  viewerLocated: boolean;
  category: ResolvedCategory | null;
  /** The area of a landing page (`area`), which centres the search. */
  area: ResolvedArea | null;
  /** What decides the result set: shared with saved searches (SearchMatcher, ADR 041). */
  criteria: SearchCriteria;
  sort: SearchQuery['sort'];
  limit: number;
  offset: number;
  /** Where Meilisearch stops paging (search_max_total_hits). */
  maxTotalHits: number;
  /** Digest the cursor is bound to. */
  queryKey: string;
  /** Digest of what narrows the list apart from the text (search_queries.filters_hash). */
  filtersHash: string;
  /** open_now: stores/places open now only (is_open_at, ADR 049). */
  openOnly: boolean;
}

/**
 * GET /search, /search/suggest (ADR 025, ADR 040).
 *
 * Scopes are the feed's (radius-based, crossing tenant boundaries, §13.26);
 * boosts count within the same slot cap as the feed (decided at index time,
 * search-documents.repository.ts). Meilisearch answers normally. When it is
 * unreachable (timeout, network, 5xx), search keeps working from Postgres
 * (`degraded: true`): the same radius, but the current tenant's rows only
 * (RLS; cross-tenant reads go through discover_nearby, 0023), substring
 * matching expanded through the synonym dictionary, no facets. After a
 * failure the engine is skipped for a short cool-down so an outage doesn't
 * cost every request a timeout.
 *
 * The first page of every text search is logged (search_queries, normalized
 * text only) for trending, synonym tuning and unmet demand; degraded
 * searches are not, since their counts cover one tenant only.
 */
@Injectable()
export class SearchService {
  private readonly synonyms = toMeilisearchSynonyms(SYNONYM_LINES);
  private engineDownUntil = 0;

  constructor(
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    private readonly matcher: SearchMatcher,
    private readonly criteria: SearchCriteriaService,
    private readonly repo: SearchQueryRepository,
    private readonly activity: SearchActivityService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SearchService.name);
  }

  async search(query: SearchQuery, signals?: ViewerSignals): Promise<SearchResponse> {
    const plan = await this.plan(query);
    if (plan.limit === 0) return this.emptyResponse(plan);

    const fromEngine = await this.tryEngine(() => this.searchEngine(plan));
    let response = await this.withOpenStates(fromEngine ?? (await this.searchDatabase(plan)));
    if (!plan.viewerLocated) {
      const hideDistance = (hit: SearchHit) => ({ ...hit, distanceMeters: null });
      response = {
        ...response,
        hits: response.hits.map(hideDistance),
        landmarks: response.landmarks.map(hideDistance),
      };
    }
    if (plan.offset === 0 && plan.qNormalized !== '' && !response.degraded && signals) {
      response.searchId = await this.activity.log({
        tenantId: plan.tenantId,
        qNormalized: plan.qNormalized,
        filtersHash: plan.filtersHash,
        resultCount: response.totalHits,
        categoryId: plan.category?.id ?? null,
        // Only where the viewer really is: the tenant's centre would skew unmet demand.
        origin: plan.viewerLocated ? plan.origin : null,
        signals,
      });
    }
    return response;
  }

  /**
   * As-you-type: matching categories, popular queries of this tenant and the
   * top listing titles nearby, in Bengali, Banglish or English. Categories
   * and popular queries come from the per-tenant cache and the listings from
   * one small engine query, all at once, so a keystroke costs a few
   * milliseconds. Without the engine, the listings are left out.
   */
  async suggest(query: SuggestQuery): Promise<SuggestResponse> {
    const tenantId = this.requireTenant();
    const [minChars, categoriesMax, queriesMax, listingsMax, defaultRadius] = await Promise.all([
      this.settings.get('search_suggest_min_chars'),
      this.settings.get('search_suggest_categories_max'),
      this.settings.get('search_suggest_queries_max'),
      this.settings.get('search_suggest_listings_max'),
      this.settings.get('search_default_radius_km', tenantId),
    ]);
    const q = normalizeSearchText(query.q);
    const empty: SuggestResponse = {
      query: query.q,
      categories: [],
      queries: [],
      listings: [],
      degraded: false,
    };
    if ([...q].length < minChars) return empty;
    const needles = this.needles(q);

    const listings =
      listingsMax === 0
        ? Promise.resolve([])
        : this.origin(tenantId, query).then((origin) =>
            this.tryEngine(async () => {
              const nearby = nearbyCriteria('posts', origin, defaultRadius);
              // Meilisearch prefix-matches only a query's last word, so the
              // half-typed text and its Banglish go as separate queries:
              // "ডাক" finds ডাক্তার, and its "dak" finds "daktar".
              const variants = [...new Set([q, hasBengali(q) ? transliterate(q) : q])];
              const results = await this.engine.multiSearch<SearchDocument>(
                variants.map((variant) => ({
                  indexUid: this.matcher.indexUid('posts'),
                  q: variant,
                  filter: this.matcher.filters(nearby),
                  sort: buildSort('relevance', origin),
                  limit: listingsMax,
                  offset: 0,
                  attributesToRetrieve: ['id', 'tenant_id', 'name_bn', 'name_en', 'category_slug'],
                })),
              );
              const seen = new Set<string>();
              return interleave(results.map((r) => r.hits))
                .filter((hit) => !seen.has(hit.id) && seen.add(hit.id))
                .slice(0, listingsMax)
                .map((hit) => ({
                  id: hit.id,
                  tenantId: hit.tenant_id,
                  title: { bn: hit.name_bn, en: hit.name_en },
                  categorySlug: hit.category_slug,
                }));
            }),
          );
    const [categories, popular, found] = await Promise.all([
      categoriesMax === 0 ? Promise.resolve([]) : this.suggestCategories(tenantId, needles),
      queriesMax === 0 ? Promise.resolve([]) : this.activity.popularPool(tenantId),
      listings,
    ]);

    return {
      query: query.q,
      categories: categories.slice(0, categoriesMax),
      queries: popular
        .filter((entry) => entry.query !== q && startsLike(entry.forms, needles))
        .slice(0, queriesMax)
        .map((entry) => ({ query: entry.query })),
      listings: found ?? [],
      degraded: found === undefined,
    };
  }

  /**
   * What typed input may be the start of: the text itself, its Banglish, and
   * its dictionary synonyms (so "doctor" also finds "ডাক্তার").
   */
  private needles(q: string): string[] {
    const needles = new Set([q, transliterate(q), ...(this.synonyms[q] ?? [])]);
    needles.delete('');
    return [...needles];
  }

  private async suggestCategories(
    tenantId: string,
    needles: readonly string[],
  ): Promise<SuggestResponse['categories']> {
    const categories = await this.activity.cached(tenantId, 'categories', async () =>
      (await this.readOnly((tx) => this.repo.tenantCategories(tx, tenantId))).map((c) => ({
        slug: c.slug,
        name: { bn: c.name_bn, en: c.name_en },
        forms: matchForms(c.name_bn, c.name_en),
      })),
    );
    return categories
      .filter((c) => startsLike(c.forms, needles))
      .map((c) => ({ slug: c.slug, name: c.name }));
  }

  /**
   * Where "nearby" is measured from: the viewer's location, or the tenant's
   * map centre when they share none. Discovery is always a radius (§13.26).
   * The centre is cached with the tenant's other search lists.
   */
  private async origin(
    tenantId: string,
    query: { lat?: number | undefined; lng?: number | undefined },
  ): Promise<{ lat: number; lng: number }> {
    if (query.lat !== undefined && query.lng !== undefined) {
      return { lat: query.lat, lng: query.lng };
    }
    const center = await this.activity.cached(
      tenantId,
      'center',
      async () => (await this.readOnly((tx) => this.repo.tenantCenter(tx, tenantId))) ?? null,
    );
    if (!center) throw new TenantNotFoundException();
    return center;
  }

  private async plan(query: SearchQuery): Promise<Plan> {
    const tenantId = this.requireTenant();
    const [pageDefault, pageMax, maxTotalHits] = await Promise.all([
      this.settings.get('search_page_size_default'),
      this.settings.get('search_page_size_max'),
      this.settings.get('search_max_total_hits'),
    ]);
    const origin = await this.origin(tenantId, query);
    const { criteria, category, area } = await this.criteria.resolve({
      tenantId,
      type: query.type,
      q: query.q,
      scope: query.scope,
      origin,
      radiusKm: query.radius_km,
      category: query.category ? { slug: query.category } : null,
      area: query.area ? { slug: query.area } : null,
      filters: query.filters,
      priceMin: query.price_min,
      priceMax: query.price_max,
    });
    const limit = Math.min(query.limit ?? pageDefault, pageMax);

    const narrowing = {
      open: query.open_now ?? false,
      type: query.type,
      scope: query.scope,
      category: category?.id ?? null,
      area: area?.id ?? null,
      filters: criteria.fieldFilters,
      price: criteria.price && [
        criteria.price.min?.toString() ?? null,
        criteria.price.max?.toString() ?? null,
      ],
    };
    const qNormalized = normalizeSearchText(query.q);
    const queryKey = searchDigest({
      ...narrowing,
      q: qNormalized,
      origin: [criteria.origin.lat, criteria.origin.lng],
      radiusKm: criteria.radiusKm,
      sort: query.sort,
      limit,
    });
    const offset = query.cursor
      ? decodeSearchCursor(query.cursor, queryKey)
      : ((query.page ?? 1) - 1) * limit;

    return {
      tenantId,
      type: query.type,
      q: query.q,
      qNormalized,
      scope: query.scope,
      // The area's centre for an area search, else the viewer (or the tenant's centre).
      origin: criteria.origin,
      radiusKm: criteria.radiusKm,
      viewerLocated: query.lat !== undefined && query.lng !== undefined,
      category,
      area,
      criteria,
      sort: query.sort,
      // Meilisearch never pages past maxTotalHits; neither does the API.
      limit: offset >= maxTotalHits ? 0 : Math.min(limit, maxTotalHits - offset),
      offset,
      maxTotalHits,
      queryKey,
      filtersHash: searchDigest(narrowing),
      openOnly: query.open_now ?? false,
    };
  }

  /** Filters of the main query, with or without the price range (the price facet ignores it). */
  private filters(plan: Plan, withPrice: boolean, matched: string[] = []): string[] {
    return this.matcher.filters(plan.criteria, { withPrice, extra: matched });
  }

  /**
   * The text part of a search. Relevance: the query itself — the text rules
   * rank first, then boosts, then the request's sort (ADR 025). An explicit
   * sort (newest, price, distance) must really sort, and in Meilisearch the
   * sort rule only breaks ties between equally good matches. So the text
   * selects instead: the ids matching every word (up to maxTotalHits) become
   * a filter, and a placeholder search orders them purely by the sort, still
   * boosted-first within the slot cap. Undefined: nothing matches.
   */
  private async textScope(plan: Plan): Promise<{ q: string; matched: string[] } | undefined> {
    const q = this.matcher.expandQuery(plan.q);
    if (plan.qNormalized === '' || plan.sort === 'relevance') return { q, matched: [] };
    const ids = await this.matcher.matchingIds(plan.criteria, {
      withPrice: false,
      limit: plan.maxTotalHits,
    });
    if (ids.length === 0) return undefined;
    return { q: '', matched: [idsIn(ids)] };
  }

  /** Stores' and places' open state (is_open_at, now), on hits and landmarks. */
  private async withOpenStates(response: SearchResponse): Promise<SearchResponse> {
    const ofType = (type: 'stores' | 'places') =>
      [...response.hits, ...response.landmarks].filter((h) => h.type === type).map((h) => h.id);
    const [stores, places] = await Promise.all(
      (['stores', 'places'] as const).map((type) => {
        const ids = ofType(type);
        return ids.length === 0
          ? Promise.resolve(new Map<string, OpenState | null>())
          : this.readOnly((tx) =>
              this.repo.openStates(tx, type === 'stores' ? 'store' : 'place', ids),
            );
      }),
    );
    const fill = (hit: SearchHit): SearchHit =>
      hit.type === 'posts'
        ? hit
        : { ...hit, openState: (hit.type === 'stores' ? stores : places)!.get(hit.id) ?? null };
    return { ...response, hits: response.hits.map(fill), landmarks: response.landmarks.map(fill) };
  }

  /**
   * open_now: the open stores/places within the radius (open_ids_near — the
   * database's is_open_at, the one implementation) become an id filter, so
   * relevance, sorting and paging stay Meilisearch's. Undefined: none open.
   */
  private async openScope(plan: Plan): Promise<string[] | undefined> {
    if (!plan.openOnly || plan.type === 'posts') return [];
    const radiusKm = plan.radiusKm ?? (await this.settings.get('search_max_radius_km'));
    const ids = await this.readOnly((tx) =>
      this.repo.openIdsNear(
        tx,
        plan.type === 'stores' ? 'store' : 'place',
        plan.origin,
        radiusKm,
        plan.maxTotalHits,
      ),
    );
    return ids.length === 0 ? undefined : [idsIn(ids)];
  }

  private async searchEngine(plan: Plan): Promise<SearchResponse> {
    const [facetFieldsMax, bucketCount, landmarksMax] = await Promise.all([
      this.settings.get('search_facet_fields_max'),
      this.settings.get('search_price_bucket_count'),
      this.settings.get('search_landmarks_max'),
    ]);
    const definition = plan.category?.definition ?? null;
    const facetFields = definition ? topFacetFields(definition, facetFieldsMax) : [];
    const wantPrice = plan.type === 'posts' && bucketCount > 0;
    const wantLandmarks =
      landmarksMax > 0 &&
      plan.type === 'posts' &&
      plan.offset === 0 &&
      plan.qNormalized !== '' &&
      plan.category === null &&
      plan.radiusKm !== null;
    const text = await this.textScope(plan);
    if (text === undefined) return this.emptyResponse(plan);
    const open = await this.openScope(plan);
    if (open === undefined) return this.emptyResponse(plan);
    const q = text.q;
    const matched = [...text.matched, ...open];
    const sort = buildSort(plan.sort, plan.origin);

    // Round 1, in parallel: the page itself; the price bounds without the
    // price filter (when one is set: the facet must show the other ranges
    // too); and the landmarks.
    const [result, priceSource, landmarks] = await Promise.all([
      this.engine.search<SearchDocument>({
        indexUid: this.matcher.indexUid(plan.type),
        q,
        filter: this.filters(plan, true, matched),
        sort,
        facets: [
          'category_slug',
          ...facetFields.map((k) => `fields.${k}`),
          ...(wantPrice ? [PRICE_ATTRIBUTE] : []),
        ],
        limit: plan.limit,
        offset: plan.offset,
      }),
      wantPrice && plan.criteria.price !== null
        ? this.engine.search<SearchDocument>({
            indexUid: this.matcher.indexUid(plan.type),
            q,
            filter: this.filters(plan, false, matched),
            facets: [PRICE_ATTRIBUTE],
            limit: 0,
            offset: 0,
          })
        : Promise.resolve(null),
      wantLandmarks
        ? this.engine.search<SearchDocument>({
            indexUid: this.matcher.indexUid('places'),
            q: this.matcher.expandQuery(plan.q),
            filter: this.matcher.filters(
              nearbyCriteria('places', plan.origin, plan.radiusKm ?? 0),
              { extra: ['is_landmark = true'] },
            ),
            sort: buildSort('distance', plan.origin),
            limit: landmarksMax,
            offset: 0,
          })
        : Promise.resolve(null),
    ]);
    // Round 2: how many results fall in each price range.
    const price = wantPrice
      ? await this.priceFacet(
          plan,
          q,
          matched,
          (priceSource ?? result).facetStats[PRICE_ATTRIBUTE],
          bucketCount,
        )
      : null;

    const reachable = Math.min(result.estimatedTotalHits, plan.maxTotalHits);
    return {
      ...this.emptyResponse(plan),
      hits: result.hits.map((hit) => this.toHit(plan.type, hit)),
      landmarks: landmarks?.hits.map((hit) => this.toHit('places', hit)) ?? [],
      totalHits: result.estimatedTotalHits,
      nextCursor:
        result.hits.length === plan.limit && plan.offset + plan.limit < reachable
          ? encodeSearchCursor(plan.queryKey, plan.offset + plan.limit)
          : null,
      facets: {
        categories: Object.entries(result.facetDistribution.category_slug ?? {})
          .map(([slug, count]) => ({ slug, count }))
          .sort((a, b) => b.count - a.count),
        price,
        fields: fieldFacets(definition, facetFields, result),
      },
    };
  }

  /** Nice price ranges over the results' price bounds, each counted exactly. */
  private async priceFacet(
    plan: Plan,
    q: string,
    matched: string[],
    stats: { min: number; max: number } | undefined,
    bucketCount: number,
  ): Promise<PriceFacet | null> {
    if (stats === undefined) return null;
    const buckets = priceBuckets(stats.min, stats.max, bucketCount);
    if (buckets.length === 0) return null;
    const base = this.filters(plan, false, matched);
    const counts = await this.engine.multiSearch<SearchDocument>(
      buckets.map((bucket) => ({
        indexUid: this.matcher.indexUid(plan.type),
        q,
        filter: [
          ...base,
          ...priceExpressions({
            min: BigInt(bucket.min),
            max: bucket.max === null ? null : BigInt(bucket.max),
          }),
        ],
        limit: 0,
        offset: 0,
        countOnly: true,
      })),
    );
    return {
      min: poishaToMoney(stats.min),
      max: poishaToMoney(stats.max),
      buckets: buckets.map((bucket, i) => ({
        min: poishaToMoney(bucket.min),
        max: bucket.max === null ? null : poishaToMoney(bucket.max),
        count: counts[i]?.estimatedTotalHits ?? 0,
      })),
    };
  }

  private async searchDatabase(plan: Plan): Promise<SearchResponse> {
    const rows = await this.readOnly((tx) =>
      this.repo.fallback(tx, plan.type, {
        terms: this.fallbackTerms(plan.q),
        categoryIds: plan.criteria.categoryIds,
        fieldFilters: plan.type === 'posts' ? plan.criteria.fieldFilters : [],
        origin: plan.origin,
        radiusKm: plan.radiusKm,
        shippableOnly: plan.criteria.shippableOnly,
        price: plan.criteria.price,
        localityId: plan.type === 'posts' ? plan.criteria.localityId : null,
        nearestFirst: plan.sort === 'distance' || plan.sort === 'relevance',
        openOnly: plan.openOnly && plan.type !== 'posts',
        limit: plan.limit,
        offset: plan.offset,
      }),
    );
    return {
      ...this.emptyResponse(plan),
      hits: rows.map((row) => fallbackHit(plan.type, row)),
      totalHits: plan.offset + rows.length,
      nextCursor:
        rows.length === plan.limit && plan.offset + plan.limit < plan.maxTotalHits
          ? encodeSearchCursor(plan.queryKey, plan.offset + plan.limit)
          : null,
      degraded: true,
    };
  }

  /**
   * The words of a degraded query plus their dictionary synonyms and
   * transliterations, so "daktar" still finds "ডাক্তার" without Meilisearch.
   */
  private fallbackTerms(q: string): string[] {
    const words = searchWords(q);
    const phrase = normalizeSearchText(q);
    const terms = new Set<string>(phrase === '' ? [] : [phrase]);
    for (const word of words) {
      terms.add(word);
      if (hasBengali(word)) terms.add(transliterateWord(word));
      for (const synonym of this.synonyms[word] ?? []) terms.add(synonym);
    }
    return [...terms].slice(0, FALLBACK_MAX_TERMS);
  }

  private toHit(type: SearchType, doc: SearchDocument & { _geoDistance?: number }): SearchHit {
    return {
      id: doc.id,
      type,
      tenantId: doc.tenant_id,
      name: { bn: doc.name_bn, en: doc.name_en },
      nameTranslit: doc.name_translit,
      description: doc.description,
      category:
        doc.category_id !== null && doc.category_slug !== null
          ? {
              id: doc.category_id,
              slug: doc.category_slug,
              name: { bn: doc.category_name_bn, en: doc.category_name_en },
            }
          : null,
      area:
        doc.area_name_bn !== null || doc.area_name_en !== null
          ? { bn: doc.area_name_bn, en: doc.area_name_en }
          : null,
      location: doc._geo,
      distanceMeters: doc._geoDistance ?? null,
      isBoosted: doc.is_boosted === 1,
      publishedAt: new Date(doc.published_at * MILLIS_PER_SECOND).toISOString(),
      price: doc.price_minor === null ? null : poishaToMoney(doc.price_minor),
      cardFields: doc.card_fields ?? {},
      rating: doc.rating_avg,
      slug: doc.slug,
      cover:
        doc.cover_thumb_key === null
          ? null
          : {
              thumbUrl: this.storage.getPublicUrl('media', doc.cover_thumb_key),
              thumbhash: doc.cover_thumbhash,
            },
      isVerified: doc.is_verified,
      isLandmark: doc.is_landmark,
      openState: null,
    };
  }

  private emptyResponse(plan: Plan): SearchResponse {
    return {
      query: plan.q,
      searchId: null,
      hits: [],
      landmarks: [],
      nextCursor: null,
      page: plan.limit > 0 ? Math.floor(plan.offset / plan.limit) + 1 : 1,
      limit: plan.limit,
      totalHits: 0,
      scope: plan.scope,
      radiusKm: plan.radiusKm,
      area: plan.area && { slug: plan.area.slug, name: plan.area.name },
      facets: { categories: [], price: null, fields: {} },
      degraded: false,
    };
  }

  /** Runs an engine call; on an outage, opens the breaker and returns undefined. */
  private async tryEngine<T>(call: () => Promise<T>): Promise<T | undefined> {
    if (Date.now() < this.engineDownUntil) return undefined;
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof SearchUnavailableError)) throw error;
      this.engineDownUntil = Date.now() + ENGINE_COOLDOWN_MS;
      this.logger.warn({ err: error }, 'search engine unavailable; answering from Postgres');
      return undefined;
    }
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private requireTenant(): string {
    const tenantId = this.tenantContext.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

/**
 * The category's facets: its first `selectMax` select-type fields (in the
 * schema's filterable order, which is the author's priority) plus every
 * numeric/date range field.
 */
export function topFacetFields(definition: CategoryFieldDefinition, selectMax: number): string[] {
  const typeOf = (key: string) => definition.jsonSchema.properties[key]?.['x-field-type'];
  const values = definition.filterableFields
    .filter((key) => VALUE_FIELD_TYPES.has(typeOf(key) ?? ''))
    .slice(0, selectMax);
  return definition.filterableFields.filter(
    (key) => values.includes(key) || RANGE_FIELD_TYPES.has(typeOf(key) ?? ''),
  );
}

/** Everything within a radius: suggestions and landmarks. */
function nearbyCriteria(
  type: SearchType,
  origin: { lat: number; lng: number },
  radiusKm: number,
): SearchCriteria {
  return {
    type,
    q: '',
    origin,
    radiusKm,
    shippableOnly: false,
    localityId: null,
    categoryIds: null,
    fieldFilters: [],
    price: null,
  };
}

/** Round-robin across lists, so each query variant contributes its best first. */
function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  }
  return out;
}

/** Starts like a needle: at the beginning of a form or of one of its words. Forms are normalized. */
function startsLike(forms: readonly string[], needles: readonly string[]): boolean {
  return forms.some((text) => needles.some((n) => text.startsWith(n) || text.includes(` ${n}`)));
}

function fieldFacets(
  definition: CategoryFieldDefinition | null,
  keys: readonly string[],
  result: EngineSearchResult<SearchDocument>,
): SearchResponse['facets']['fields'] {
  const facets: SearchResponse['facets']['fields'] = {};
  if (definition === null) return facets;
  for (const key of keys) {
    const type = definition.jsonSchema.properties[key]?.['x-field-type'];
    const attribute = `fields.${key}`;
    if (type !== undefined && VALUE_FIELD_TYPES.has(type)) {
      const values = Object.entries(result.facetDistribution[attribute] ?? {})
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
      if (values.length > 0) facets[key] = { kind: 'values', values };
    } else if (type !== undefined && RANGE_FIELD_TYPES.has(type)) {
      const stats = result.facetStats[attribute];
      if (stats === undefined) continue;
      const show = (n: number) =>
        MONEY_FIELD_TYPES.has(type) ? poishaToMoney(n) : type === 'date' ? yyyymmddToDate(n) : n;
      facets[key] = { kind: 'range', min: show(stats.min), max: show(stats.max) };
    }
  }
  return facets;
}

function fallbackHit(type: SearchType, row: FallbackRow): SearchHit {
  return {
    id: row.id,
    type,
    tenantId: row.tenant_id,
    name: { bn: row.name_bn, en: row.name_en },
    nameTranslit: transliterate(row.name_bn ?? row.name_en ?? ''),
    description: row.description,
    category:
      row.category_id !== null && row.category_slug !== null
        ? {
            id: row.category_id,
            slug: row.category_slug,
            name: { bn: row.category_name_bn, en: row.category_name_en },
          }
        : null,
    area: null,
    location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    distanceMeters: row.distance_m,
    isBoosted: false,
    publishedAt: row.published_at.toISOString(),
    price: row.price,
    cardFields: {},
    rating: null,
    slug: row.slug,
    cover: null,
    isVerified: false,
    isLandmark: false,
    openState: null,
  };
}

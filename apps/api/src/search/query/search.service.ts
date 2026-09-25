import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import {
  parseFieldFilters,
  type CategoryFieldDefinition,
  type FieldFilter,
} from '../../categories/field-schema';
import { TenantContext } from '../../database/tenant-context';
import { TenantNotFoundException, TenantRequiredException } from '../../database/tenant.exceptions';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/storage.ports';
import type {
  SearchHit,
  SearchQuery,
  SearchResponse,
  Suggestion,
  SuggestQuery,
  SuggestResponse,
} from '../dto/search.dto';
import {
  SEARCH_ENGINE,
  SearchUnavailableError,
  type EngineSearchResult,
  type SearchEngine,
} from '../engine/search-engine.port';
import {
  SearchCategoryNotFoundException,
  SearchFiltersNeedFieldsException,
} from '../search.exceptions';
import { indexUid, SEARCH_TYPES, type SearchDocument, type SearchType } from '../search.types';
import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { toMeilisearchSynonyms } from '../synonyms/synonym-dictionary';
import { hasBengali, normalizeSearchText, searchWords } from '../text/normalize';
import { SearchTerms } from '../text/search-terms';
import { transliterate, transliterateWord } from '../text/transliterate';
import { buildSearchFilter, buildSort, type GeoScope } from './filter-builder';
import {
  SearchQueryRepository,
  type FallbackRow,
  type ResolvedCategory,
} from './search-query.repository';

// settings-exempt: circuit-breaker window after the engine fails (resilience tuning): requests skip straight to Postgres meanwhile
const ENGINE_COOLDOWN_MS = 10_000;
// settings-exempt: bounds the ILIKE alternatives of a degraded query (query cost), not a business rule
const FALLBACK_MAX_TERMS = 24;
// settings-exempt: category suggestions shown before listing suggestions (layout)
const MAX_CATEGORY_SUGGESTIONS = 3;
const POISHA_PER_TAKA = 100; // settings-exempt: currency unit conversion
const MONEY_DECIMALS = 2; // settings-exempt: the scale of numeric(12,2), a column type
const MILLIS_PER_SECOND = 1_000; // settings-exempt: unit conversion
const MONEY_FIELD_TYPES = new Set(['money']);
const RANGE_FIELD_TYPES = new Set(['number', 'money', 'date']);
const VALUE_FIELD_TYPES = new Set(['select', 'multiselect', 'bool']);

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
  geo: GeoScope;
  /** False when geo is the tenant's centre, not the viewer: distances then mean nothing to them. */
  viewerLocated: boolean;
  category: ResolvedCategory | null;
  fieldFilters: FieldFilter[];
  page: number;
  limit: number;
  offset: number;
  sort: SearchQuery['sort'];
}

/**
 * GET /search and GET /search/suggest.
 *
 * Meilisearch answers normally. When it is unreachable (timeout, network,
 * 5xx), search keeps working from Postgres (`degraded: true`): the same
 * radius, but the current tenant's rows only (RLS; cross-tenant reads go
 * through discover_nearby, 0023), substring matching expanded through the
 * synonym dictionary, no facets. Without the viewer's location, "nearby" is
 * measured from the tenant's map centre and hits carry no distance. After a failure the engine is skipped for a short cool-down so
 * an outage doesn't cost every request a timeout.
 */
@Injectable()
export class SearchService {
  private readonly terms = new SearchTerms(SYNONYM_LINES);
  private readonly synonyms = toMeilisearchSynonyms(SYNONYM_LINES);
  private readonly prefix: string;
  private engineDownUntil = 0;

  constructor(
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    private readonly repo: SearchQueryRepository,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(APP_CONFIG) env: Pick<Env, 'MEILI_INDEX_PREFIX'>,
    private readonly logger: PinoLogger,
  ) {
    this.prefix = env.MEILI_INDEX_PREFIX;
    this.logger.setContext(SearchService.name);
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const plan = await this.plan(query);
    const empty = this.emptyResponse(plan);
    if (plan.limit === 0) return empty;

    const fromEngine = await this.tryEngine(() => this.searchEngine(plan));
    const response = fromEngine ?? (await this.searchDatabase(plan));
    return plan.viewerLocated
      ? response
      : { ...response, hits: response.hits.map((hit) => ({ ...hit, distanceMeters: null })) };
  }

  async suggest(query: SuggestQuery): Promise<SuggestResponse> {
    const tenantId = this.requireTenant();
    const [minChars, limit, defaultRadius] = await Promise.all([
      this.settings.get('search_suggest_min_chars'),
      this.settings.get('search_suggest_limit'),
      this.settings.get('search_default_radius_km', tenantId),
    ]);
    const q = normalizeSearchText(query.q);
    if ([...q].length < minChars) return { query: query.q, suggestions: [], degraded: false };

    const categories = (await this.categorySuggestions(tenantId, q)).slice(
      0,
      MAX_CATEGORY_SUGGESTIONS,
    );
    const geo = { ...(await this.origin(tenantId, query)), radiusKm: defaultRadius };
    const perType = Math.max(1, limit - categories.length);
    const listings = await this.tryEngine(async () => {
      const results = await this.engine.multiSearch<SearchDocument>(
        SEARCH_TYPES.map((type) => ({
          indexUid: indexUid(this.prefix, type),
          q: this.terms.expandQuery(q),
          filter: buildSearchFilter({ geo, categoryIds: null, fieldFilters: [] }),
          sort: buildSort('relevance', geo),
          limit: perType,
          offset: 0,
          attributesToRetrieve: ['id', 'name_bn', 'name_en', 'category_slug', 'slug'],
        })),
      );
      return interleave(
        results.map((result, i) =>
          result.hits.map((hit): Suggestion => ({
            kind: SEARCH_TYPES[i]!,
            id: hit.id,
            name: { bn: hit.name_bn, en: hit.name_en },
            categorySlug: hit.category_slug,
            slug: hit.slug,
          })),
        ),
      );
    });

    return {
      query: query.q,
      suggestions: [...categories, ...(listings ?? [])].slice(0, limit),
      degraded: listings === undefined,
    };
  }

  /**
   * Where "nearby" is measured from: the viewer's location, or the tenant's
   * map centre when they share none. Discovery is always a radius (§13.26).
   */
  private async origin(
    tenantId: string,
    query: { lat?: number | undefined; lng?: number | undefined },
  ): Promise<{ lat: number; lng: number }> {
    if (query.lat !== undefined && query.lng !== undefined) {
      return { lat: query.lat, lng: query.lng };
    }
    const center = await this.tenantDb.transaction((tx) => this.repo.tenantCenter(tx, tenantId), {
      accessMode: 'read only',
    });
    if (!center) throw new TenantNotFoundException();
    return center;
  }

  private async plan(query: SearchQuery): Promise<Plan> {
    const tenantId = this.requireTenant();
    const [defaultRadius, maxRadius, pageDefault, pageMax, maxTotalHits] = await Promise.all([
      this.settings.get('search_default_radius_km', tenantId),
      this.settings.get('search_max_radius_km'),
      this.settings.get('search_page_size_default'),
      this.settings.get('search_page_size_max'),
      this.settings.get('search_max_total_hits'),
    ]);

    const category = query.category
      ? await this.tenantDb.transaction((tx) => this.repo.resolveCategory(tx, query.category!), {
          accessMode: 'read only',
        })
      : null;
    if (query.category && !category) throw new SearchCategoryNotFoundException();

    let fieldFilters: FieldFilter[] = [];
    if (query.filters && query.filters.length > 0) {
      if (!category?.definition) throw new SearchFiltersNeedFieldsException();
      fieldFilters = parseFieldFilters(category.definition, query.filters);
    }

    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const offset = (query.page - 1) * limit;
    return {
      tenantId,
      type: query.type,
      q: query.q,
      geo: {
        ...(await this.origin(tenantId, query)),
        radiusKm: Math.min(query.radius ?? defaultRadius, maxRadius),
      },
      viewerLocated: query.lat !== undefined && query.lng !== undefined,
      category: category ?? null,
      fieldFilters,
      page: query.page,
      // Meilisearch never pages past maxTotalHits; neither does the API.
      limit: offset >= maxTotalHits ? 0 : Math.min(limit, maxTotalHits - offset),
      offset,
      sort: query.sort,
    };
  }

  private async searchEngine(plan: Plan): Promise<SearchResponse> {
    const definition = plan.category?.definition ?? null;
    const facetFields = definition
      ? definition.filterableFields.filter((key) => {
          const type = definition.jsonSchema.properties[key]?.['x-field-type'];
          return type !== undefined && (VALUE_FIELD_TYPES.has(type) || RANGE_FIELD_TYPES.has(type));
        })
      : [];
    const result = await this.engine.search<SearchDocument>({
      indexUid: indexUid(this.prefix, plan.type),
      q: this.terms.expandQuery(plan.q),
      filter: buildSearchFilter({
        geo: plan.geo,
        categoryIds: plan.category?.ids ?? null,
        fieldFilters: plan.fieldFilters,
      }),
      sort: buildSort(plan.sort, plan.geo),
      facets: ['category_slug', ...facetFields.map((k) => `fields.${k}`)],
      limit: plan.limit,
      offset: plan.offset,
    });
    return {
      ...this.emptyResponse(plan),
      hits: result.hits.map((hit) => this.toHit(plan.type, hit)),
      totalHits: result.estimatedTotalHits,
      facets: {
        categories: Object.entries(result.facetDistribution.category_slug ?? {})
          .map(([slug, count]) => ({ slug, count }))
          .sort((a, b) => b.count - a.count),
        fields: fieldFacets(definition, facetFields, result),
      },
    };
  }

  private async searchDatabase(plan: Plan): Promise<SearchResponse> {
    const rows = await this.tenantDb.transaction(
      (tx) =>
        this.repo.fallback(tx, plan.type, {
          terms: this.fallbackTerms(plan.q),
          categoryIds: plan.category?.ids ?? null,
          fieldFilters: plan.type === 'posts' ? plan.fieldFilters : [],
          geo: plan.geo,
          nearestFirst: plan.sort === 'nearest' || plan.sort === 'relevance',
          limit: plan.limit,
          offset: plan.offset,
        }),
      { accessMode: 'read only' },
    );
    return {
      ...this.emptyResponse(plan),
      hits: rows.map((row) => fallbackHit(plan.type, row)),
      totalHits: plan.offset + rows.length,
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

  private async categorySuggestions(tenantId: string, q: string): Promise<Suggestion[]> {
    const categories = await this.tenantDb.transaction(
      (tx) => this.repo.tenantCategories(tx, tenantId),
      {
        accessMode: 'read only',
      },
    );
    const needles = new Set(
      [q, transliterate(q), ...(this.synonyms[q] ?? [])].filter((n) => n !== ''),
    );
    const matches = (candidate: string) => {
      const text = normalizeSearchText(candidate);
      return [...needles].some((n) => text.startsWith(n) || text.includes(` ${n}`));
    };
    return categories
      .filter((c) => [c.name_bn, c.name_en, transliterate(c.name_bn)].some(matches))
      .map((c) => ({
        kind: 'category' as const,
        slug: c.slug,
        name: { bn: c.name_bn, en: c.name_en },
      }));
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
    };
  }

  private emptyResponse(plan: Plan): SearchResponse {
    return {
      query: plan.q,
      hits: [],
      page: plan.page,
      limit: plan.limit,
      totalHits: 0,
      facets: { categories: [], fields: {} },
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

  private requireTenant(): string {
    const tenantId = this.tenantContext.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
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
  };
}

/** Round-robin across lists, so suggestions mix posts, stores and places. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  }
  return out;
}

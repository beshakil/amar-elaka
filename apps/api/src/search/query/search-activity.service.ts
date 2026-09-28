import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CacheService } from '../../cache/cache.service';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantRequiredException } from '../../database/tenant.exceptions';
import { TenantDb } from '../../database/tenant-db';
import type { ViewerSignals } from '../../engagement/viewer-key';
import { SettingsService } from '../../settings/settings.service';
import type { SearchClick, SearchClickResult, TrendingResponse } from '../dto/search.dto';
import { normalizeSearchText } from '../text/normalize';
import { transliterate } from '../text/transliterate';
import { searcherHash } from './searcher-hash';
import { SearchQueryRepository } from './search-query.repository';

// v1: first shape of the cached lists.
const CACHE_KEY_VERSION = 'v1';

/** A popular query with the forms typed input is matched against, computed once per cache fill. */
export interface PopularQueryEntry {
  query: string;
  /** Normalized text and its Banglish. */
  forms: string[];
}

/** The spellings of a text that as-you-type input may start: itself and its Banglish. */
export function matchForms(...texts: (string | null)[]): string[] {
  const forms = new Set<string>();
  for (const text of texts) {
    if (text === null) continue;
    const normalized = normalizeSearchText(text);
    if (normalized !== '') forms.add(normalized);
    const translit = normalizeSearchText(transliterate(normalized));
    if (translit !== '') forms.add(translit);
  }
  return [...forms];
}
// settings-exempt: unit conversions (the durations themselves are settings)
const MS_PER_HOUR = 3_600_000;
// settings-exempt: see above
const MS_PER_DAY = 86_400_000;

/** A search worth logging: the first page of a text search. */
export interface SearchLogEntry {
  tenantId: string;
  qNormalized: string;
  filtersHash: string;
  resultCount: number;
  categoryId: string | null;
  /** The viewer's location, if they shared it; stored rounded (search_log_origin_decimals). */
  origin: { lat: number; lng: number } | null;
  signals: ViewerSignals;
}

/** Rounds a coordinate to `decimals` places (2 ≈ 1 km): the log never holds an exact location. */
export function roundCoordinate(value: number, decimals: number): number {
  // settings-exempt: decimal base; the number of places is search_log_origin_decimals
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The query log and what is built on it (ADR 040): logging a search,
 * recording the result the searcher opened, trending queries and the
 * popular-query pool suggestions draw from.
 *
 * Only the normalized query is ever stored — never the raw text, for anyone.
 * The public reads aggregates only (search_popular_queries, 0034), counted
 * in distinct searchers so one person can't make a query trend.
 */
@Injectable()
export class SearchActivityService {
  private readonly secret: string;

  constructor(
    private readonly repo: SearchQueryRepository,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly cache: CacheService,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_SECRET'>,
    private readonly logger: PinoLogger,
  ) {
    this.secret = env.JWT_SECRET;
    this.logger.setContext(SearchActivityService.name);
  }

  /**
   * Logs one search in the searcher's own context (as themselves, or
   * anonymously). Returns its id for POST /search/click, or null if the log
   * write failed: a search never fails because of its log.
   */
  async log(entry: SearchLogEntry): Promise<string | null> {
    const userId = this.context.current()?.userId ?? null;
    try {
      const decimals = await this.settings.get('search_log_origin_decimals');
      return await this.tenantDb.transaction((tx) =>
        this.repo.logQuery(tx, {
          tenantId: entry.tenantId,
          userId,
          searcherHash: searcherHash(
            this.secret,
            { ...entry.signals, userId: userId ?? undefined },
            new Date(),
          ),
          qNormalized: entry.qNormalized,
          filtersHash: entry.filtersHash,
          resultCount: entry.resultCount,
          categoryId: entry.categoryId,
          origin:
            entry.origin === null
              ? null
              : {
                  lat: roundCoordinate(entry.origin.lat, decimals),
                  lng: roundCoordinate(entry.origin.lng, decimals),
                },
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'could not log a search');
      return null;
    }
  }

  /** The searcher opened a result: recorded once, on their own recent search. */
  async click(click: SearchClick): Promise<SearchClickResult> {
    this.requireTenant();
    const windowMinutes = await this.settings.get('search_click_window_minutes');
    const recorded = await this.tenantDb.transaction((tx) =>
      this.repo.recordClick(tx, click.searchId, click.postId, windowMinutes),
    );
    return { recorded };
  }

  /** GET /search/trending: this tenant's top queries over trending_window_hours. */
  async trending(): Promise<TrendingResponse> {
    const tenantId = this.requireTenant();
    const [windowHours, minSearchers, limit] = await Promise.all([
      this.settings.get('trending_window_hours', tenantId),
      this.settings.get('search_trending_min_searchers', tenantId),
      this.settings.get('search_trending_limit'),
    ]);
    const queries = await this.cached(
      tenantId,
      ['trending', windowHours, minSearchers, limit].join(':'),
      async () =>
        (
          await this.readOnly((tx) =>
            this.repo.popularQueries(
              tx,
              new Date(Date.now() - windowHours * MS_PER_HOUR),
              minSearchers,
              limit,
            ),
          )
        ).map((q) => ({ query: q.q_normalized, searchers: q.searchers })),
    );
    return { windowHours, queries };
  }

  /**
   * The popular queries suggestions match against: the tenant's top
   * search_popular_pool_size over search_popular_window_days, most popular
   * first, under the same distinct-searcher threshold as trending.
   */
  async popularPool(tenantId: string): Promise<PopularQueryEntry[]> {
    const [days, minSearchers, size] = await Promise.all([
      this.settings.get('search_popular_window_days'),
      this.settings.get('search_trending_min_searchers', tenantId),
      this.settings.get('search_popular_pool_size'),
    ]);
    return this.cached(tenantId, ['popular', days, minSearchers, size].join(':'), async () =>
      (
        await this.readOnly((tx) =>
          this.repo.popularQueries(
            tx,
            new Date(Date.now() - days * MS_PER_DAY),
            minSearchers,
            size,
          ),
        )
      ).map((q) => ({ query: q.q_normalized, forms: matchForms(q.q_normalized) })),
    );
  }

  /** A per-tenant list cached for search_list_cache_seconds (0 = always fresh). */
  async cached<T>(tenantId: string, key: string, load: () => Promise<T>): Promise<T> {
    const ttl = await this.settings.get('search_list_cache_seconds');
    if (ttl === 0) return load();
    return this.cache
      .forTenant(tenantId)
      .remember(['search', CACHE_KEY_VERSION, key].join(':'), ttl, load);
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private requireTenant(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

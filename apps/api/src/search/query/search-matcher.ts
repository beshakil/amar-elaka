import { Inject, Injectable } from '@nestjs/common';
import type { FieldFilter } from '../../categories/field-schema';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { SEARCH_ENGINE, type SearchEngine } from '../engine/search-engine.port';
import { indexUid, type SearchDocument, type SearchType } from '../search.types';
import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { SearchTerms } from '../text/search-terms';
import { buildSearchFilter, idsIn, type GeoScope, type PriceRange } from './filter-builder';

// settings-exempt: queries per engine multi-search request (transport batching), not a business rule
const MULTI_SEARCH_BATCH = 100;

/**
 * Everything that decides whether a document is in a search's results,
 * independent of how the results are ordered or shown. Built by
 * SearchCriteriaService from a request (GET /search) or a stored saved
 * search, so both mean exactly the same thing.
 */
export interface SearchCriteria {
  type: SearchType;
  /** As typed; expanded through transliteration and synonyms here. */
  q: string;
  /** Where the radius is measured from. */
  origin: { lat: number; lng: number };
  /** Null: no radius (the country scope). */
  radiusKm: number | null;
  /** Shippable categories only (the country scope). */
  shippableOnly: boolean;
  /** The category and its active descendants; null = any. */
  categoryIds: readonly string[] | null;
  /** One area of a tenant, as well as the radius (ADR 042); null = any. */
  localityId: string | null;
  fieldFilters: readonly FieldFilter[];
  /** Posts only: price bounds in poisha. */
  price: PriceRange | null;
}

/**
 * THE one implementation of "does this document match these criteria"
 * (ADR 041). GET /search compiles its filters here, and the saved-search
 * matcher asks the same question of the same engine through matchEach —
 * there is no second filter evaluator to drift from the first
 * (architecture/single-matcher.spec.ts keeps it that way).
 */
@Injectable()
export class SearchMatcher {
  private readonly terms = new SearchTerms(SYNONYM_LINES);
  private readonly prefix: string;

  constructor(
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    @Inject(APP_CONFIG) env: Pick<Env, 'MEILI_INDEX_PREFIX'>,
  ) {
    this.prefix = env.MEILI_INDEX_PREFIX;
  }

  indexUid(type: SearchType): string {
    return indexUid(this.prefix, type);
  }

  /** The text as the engine receives it: Banglish first, then as typed (ADR 025). */
  expandQuery(q: string): string {
    return this.terms.expandQuery(q);
  }

  geo(criteria: SearchCriteria): GeoScope | null {
    return criteria.radiusKm === null ? null : { ...criteria.origin, radiusKm: criteria.radiusKm };
  }

  /**
   * The engine filter for these criteria. `withPrice: false` leaves the
   * price range out (the price facet shows every range); `extra` narrows
   * further (an id list).
   */
  filters(
    criteria: SearchCriteria,
    options: { withPrice?: boolean; extra?: readonly string[] } = {},
  ): string[] {
    return [
      ...buildSearchFilter({
        geo: this.geo(criteria),
        shippableOnly: criteria.shippableOnly,
        localityId: criteria.localityId,
        categoryIds: criteria.categoryIds,
        fieldFilters: criteria.fieldFilters,
        price: options.withPrice === false ? null : criteria.price,
      }),
      ...(options.extra ?? []),
    ];
  }

  /**
   * Ids of documents matching the criteria: every filter, and every word of
   * the text (none needed when there is no text), optionally only among
   * `within`. Up to `limit`, best text match first.
   */
  async matchingIds(
    criteria: SearchCriteria,
    options: { within?: readonly string[]; withPrice?: boolean; limit: number },
  ): Promise<string[]> {
    if (options.within?.length === 0) return [];
    const result = await this.engine.search<Pick<SearchDocument, 'id'>>(
      this.idRequest(criteria, options.within, options.withPrice, options.limit),
    );
    return result.hits.map((hit) => hit.id);
  }

  /**
   * matchingIds for many criteria at once, each restricted to its own
   * candidates (the saved-search matcher: one entry per search, its
   * candidates the new posts near it). Batched into multi-searches.
   */
  async matchEach(
    items: readonly { criteria: SearchCriteria; within: readonly string[] }[],
  ): Promise<string[][]> {
    const out: string[][] = items.map(() => []);
    const pending = items
      .map((item, index) => ({ ...item, index }))
      .filter((item) => item.within.length > 0);
    for (let i = 0; i < pending.length; i += MULTI_SEARCH_BATCH) {
      const batch = pending.slice(i, i + MULTI_SEARCH_BATCH);
      const results = await this.engine.multiSearch<Pick<SearchDocument, 'id'>>(
        batch.map((item) => this.idRequest(item.criteria, item.within, true, item.within.length)),
      );
      batch.forEach((item, j) => {
        out[item.index] = (results[j]?.hits ?? []).map((hit) => hit.id);
      });
    }
    return out;
  }

  /**
   * How many documents match each criteria, per value of [attribute] (a
   * facet): the category + area landing pages count their listings with
   * the same criteria the page then shows (ADR 042). One multi-search.
   */
  async facetCountsEach(
    items: readonly SearchCriteria[],
    attribute: string,
  ): Promise<Record<string, number>[]> {
    const out: Record<string, number>[] = [];
    for (let i = 0; i < items.length; i += MULTI_SEARCH_BATCH) {
      const batch = items.slice(i, i + MULTI_SEARCH_BATCH);
      const results = await this.engine.multiSearch<Pick<SearchDocument, 'id'>>(
        batch.map((criteria) => ({
          indexUid: this.indexUid(criteria.type),
          q: criteria.q.trim() === '' ? '' : this.expandQuery(criteria.q),
          filter: this.filters(criteria),
          facets: [attribute],
          limit: 0,
          offset: 0,
          matchingStrategy: 'all' as const,
        })),
      );
      out.push(...results.map((r) => r.facetDistribution[attribute] ?? {}));
    }
    return out;
  }

  private idRequest(
    criteria: SearchCriteria,
    within: readonly string[] | undefined,
    withPrice: boolean | undefined,
    limit: number,
  ) {
    const text = criteria.q.trim() !== '';
    return {
      indexUid: this.indexUid(criteria.type),
      q: text ? this.expandQuery(criteria.q) : '',
      filter: this.filters(criteria, {
        ...(withPrice === undefined ? {} : { withPrice }),
        extra: within === undefined ? [] : [idsIn(within)],
      }),
      limit,
      offset: 0,
      attributesToRetrieve: ['id'],
      // Every word must match: a saved search alerts only on real matches,
      // and an explicitly sorted search lists only those (ADR 040).
      matchingStrategy: 'all' as const,
    };
  }
}

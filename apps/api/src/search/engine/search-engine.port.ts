/**
 * What search needs from the engine. The API and the worker depend on this
 * port, not on the Meilisearch client, so tests use an in-memory fake and
 * every failure surfaces as one of the typed errors below.
 */

export interface EngineSearchRequest {
  indexUid: string;
  q: string;
  filter?: string[];
  sort?: string[];
  facets?: string[];
  limit: number;
  offset: number;
  attributesToRetrieve?: string[];
}

export interface EngineSearchResult<T> {
  hits: (T & { _geoDistance?: number })[];
  estimatedTotalHits: number;
  facetDistribution: Record<string, Record<string, number>>;
  facetStats: Record<string, { min: number; max: number }>;
}

/** The subset of Meilisearch index settings this app manages. */
export interface EngineIndexSettings {
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  displayedAttributes: string[];
  rankingRules: string[];
  synonyms: Record<string, string[]>;
  typoTolerance: {
    enabled: boolean;
    minWordSizeForTypos: { oneTypo: number; twoTypos: number };
    disableOnAttributes: string[];
  };
  separatorTokens: string[];
  faceting: { maxValuesPerFacet: number };
  pagination: { maxTotalHits: number };
}

export interface SearchEngine {
  search<T extends object>(request: EngineSearchRequest): Promise<EngineSearchResult<T>>;
  multiSearch<T extends object>(requests: EngineSearchRequest[]): Promise<EngineSearchResult<T>[]>;
  /** The write calls below resolve once the engine has applied the change. */
  upsertDocuments(indexUid: string, documents: readonly object[]): Promise<void>;
  deleteDocuments(indexUid: string, ids: readonly string[]): Promise<void>;
  ensureIndex(indexUid: string): Promise<void>;
  updateSettings(indexUid: string, settings: EngineIndexSettings): Promise<void>;
  /** Atomically exchanges the contents of two indexes. */
  swapIndexes(a: string, b: string): Promise<void>;
  deleteIndex(indexUid: string): Promise<void>;
}

export const SEARCH_ENGINE = Symbol('SEARCH_ENGINE');

/** The engine didn't answer in time, couldn't be reached, or failed on its side. Worth retrying. */
export class SearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The search engine is unavailable.', { cause });
    this.name = 'SearchUnavailableError';
  }
}

/** The engine refused the request (bad filter, bad settings) — a bug, not an outage. */
export class SearchRequestRejectedError extends Error {
  constructor(
    readonly engineCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'SearchRequestRejectedError';
  }
}

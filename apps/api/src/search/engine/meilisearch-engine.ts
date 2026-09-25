import { Inject, Injectable } from '@nestjs/common';
import {
  MeiliSearch,
  MeiliSearchApiError,
  type EnqueuedTask,
  type MultiSearchQuery,
  type SearchParams,
} from 'meilisearch';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { withRetry } from '../../common/utils/with-timeout';
import {
  SearchRequestRejectedError,
  SearchUnavailableError,
  type EngineIndexSettings,
  type EngineSearchRequest,
  type EngineSearchResult,
  type SearchEngine,
} from './search-engine.port';

// settings-exempt: transport tuning for index writes (a 500-document batch or a settings change can take seconds to apply), not a business rule
const WRITE_TIMEOUT_MS = 60_000;
// settings-exempt: see above
const TASK_POLL_INTERVAL_MS = 50;
// settings-exempt: reads are retried once (CLAUDE.md rule 5); writes are retried by the outbox
const READ_ATTEMPTS = 2;
// settings-exempt: see above
const READ_RETRY_DELAY_MS = 50;
const HTTP_NOT_FOUND = 404; // settings-exempt: HTTP status code
const HTTP_SERVER_ERROR = 500; // settings-exempt: HTTP status code

/**
 * Meilisearch behind the SearchEngine port. Reads use a short timeout and one
 * retry, so a slow engine degrades search instead of hanging requests;
 * writes use a long timeout and wait for the task, so the outbox only marks
 * an event done once the engine has really applied it.
 */
@Injectable()
export class MeilisearchEngine implements SearchEngine {
  private readonly reader: MeiliSearch;
  private readonly writer: MeiliSearch;

  constructor(
    @Inject(APP_CONFIG) env: Pick<Env, 'MEILI_HOST' | 'MEILI_MASTER_KEY' | 'MEILI_TIMEOUT_MS'>,
  ) {
    const base = { host: env.MEILI_HOST, apiKey: env.MEILI_MASTER_KEY };
    this.reader = new MeiliSearch({ ...base, timeout: env.MEILI_TIMEOUT_MS });
    this.writer = new MeiliSearch({ ...base, timeout: WRITE_TIMEOUT_MS });
  }

  async search<T extends object>(request: EngineSearchRequest): Promise<EngineSearchResult<T>> {
    const response = await this.read(() =>
      this.reader.index(request.indexUid).search(request.q, toParams(request)),
    );
    return toResult<T>(response);
  }

  async multiSearch<T extends object>(
    requests: EngineSearchRequest[],
  ): Promise<EngineSearchResult<T>[]> {
    const queries: MultiSearchQuery[] = requests.map((r) => ({
      indexUid: r.indexUid,
      q: r.q,
      ...toParams(r),
    }));
    const response = await this.read(() => this.reader.multiSearch({ queries }));
    return response.results.map((r) => toResult<T>(r));
  }

  upsertDocuments(indexUid: string, documents: readonly object[]): Promise<void> {
    if (documents.length === 0) return Promise.resolve();
    return this.write(() =>
      this.writer.index(indexUid).addDocuments([...documents] as Record<string, unknown>[], {
        primaryKey: 'id',
      }),
    );
  }

  deleteDocuments(indexUid: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.write(() => this.writer.index(indexUid).deleteDocuments([...ids]));
  }

  async ensureIndex(indexUid: string): Promise<void> {
    try {
      await this.writer.getIndex(indexUid);
      return;
    } catch (error) {
      if (!(error instanceof MeiliSearchApiError) || error.response?.status !== HTTP_NOT_FOUND) {
        throw translate(error);
      }
    }
    await this.write(() => this.writer.createIndex(indexUid, { primaryKey: 'id' }));
  }

  updateSettings(indexUid: string, settings: EngineIndexSettings): Promise<void> {
    return this.write(() => this.writer.index(indexUid).updateSettings(settings));
  }

  swapIndexes(a: string, b: string): Promise<void> {
    return this.write(() => this.writer.swapIndexes([{ indexes: [a, b] }]));
  }

  /** Deleting an index that doesn't exist is a no-op. */
  async deleteIndex(indexUid: string): Promise<void> {
    try {
      await this.write(() => this.writer.deleteIndex(indexUid));
    } catch (error) {
      if (!(
        error instanceof SearchRequestRejectedError && error.engineCode === 'index_not_found'
      )) {
        throw error;
      }
    }
  }

  private async read<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(call, READ_ATTEMPTS, READ_RETRY_DELAY_MS);
    } catch (error) {
      throw translate(error);
    }
  }

  private async write(enqueue: () => Promise<EnqueuedTask>): Promise<void> {
    try {
      const { taskUid } = await enqueue();
      const task = await this.writer.waitForTask(taskUid, {
        timeOutMs: WRITE_TIMEOUT_MS,
        intervalMs: TASK_POLL_INTERVAL_MS,
      });
      if (task.status !== 'succeeded') {
        throw new SearchRequestRejectedError(
          task.error?.code ?? task.status,
          task.error?.message ?? `task ${task.status}`,
        );
      }
    } catch (error) {
      throw translate(error);
    }
  }
}

function toParams(request: EngineSearchRequest): SearchParams {
  return {
    limit: request.limit,
    offset: request.offset,
    ...(request.filter && request.filter.length > 0 ? { filter: request.filter } : {}),
    ...(request.sort && request.sort.length > 0 ? { sort: request.sort } : {}),
    ...(request.facets && request.facets.length > 0 ? { facets: request.facets } : {}),
    ...(request.attributesToRetrieve ? { attributesToRetrieve: request.attributesToRetrieve } : {}),
  };
}

interface RawResult {
  hits: object[];
  estimatedTotalHits?: number;
  totalHits?: number;
  facetDistribution?: Record<string, Record<string, number>>;
  facetStats?: Record<string, { min: number; max: number }>;
}

function toResult<T extends object>(response: RawResult): EngineSearchResult<T> {
  return {
    hits: response.hits as EngineSearchResult<T>['hits'],
    estimatedTotalHits: response.estimatedTotalHits ?? response.totalHits ?? response.hits.length,
    facetDistribution: response.facetDistribution ?? {},
    facetStats: response.facetStats ?? {},
  };
}

/** Engine-side 4xx → rejected (a bug); everything else → unavailable (retry / degrade). */
function translate(error: unknown): Error {
  if (error instanceof SearchRequestRejectedError || error instanceof SearchUnavailableError) {
    return error;
  }
  if (error instanceof MeiliSearchApiError) {
    const status = error.response?.status ?? HTTP_SERVER_ERROR;
    if (status < HTTP_SERVER_ERROR) {
      return new SearchRequestRejectedError(error.cause?.code ?? 'api_error', error.message);
    }
  }
  return new SearchUnavailableError(error);
}

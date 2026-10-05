import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DomainException } from '../../common/exceptions/domain-exception';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { JobBudget, JobOutcome } from '../../jobs/job-batches';
import { SearchCriteriaService } from '../../search/query/search-criteria.service';
import { SearchMatcher, type SearchCriteria } from '../../search/query/search-matcher';
import { SettingsService } from '../../settings/settings.service';
import { savedSearchCriteriaInput } from '../saved-search-criteria';
import { SavedSearchesRepository } from '../saved-searches.repository';

/**
 * Matches newly published posts against active saved searches (ADR 041).
 * A scheduled worker job, never part of publishing a post.
 *
 * Per tenant, a watermark walks the tenant's posts in publication order; a
 * post is looked at once it has been live for saved_search_match_grace_seconds
 * (by then the outbox relay has indexed it). For each batch:
 *
 *   1. candidates: active searches whose circle holds the post (PostGIS),
 *      not the author's own — a narrowing only;
 *   2. the decision: SearchMatcher.matchEach, the same criteria → filter →
 *      engine path as GET /search (SearchCriteriaService turns the stored
 *      search into criteria exactly as it turns a request into them);
 *   3. matches are recorded (idempotent), then the watermark moves on.
 *
 * If the engine is down the batch fails before the watermark moves, and the
 * next run retries it: there is no second way of matching to fall back on.
 */
@Injectable()
export class SavedSearchMatcherService {
  constructor(
    private readonly repo: SavedSearchesRepository,
    private readonly criteria: SearchCriteriaService,
    private readonly matcher: SearchMatcher,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SavedSearchMatcherService.name);
  }

  async matchNewPosts(budget: JobBudget): Promise<JobOutcome> {
    const grace = await this.settings.get('saved_search_match_grace_seconds');
    const tenants = await this.asSystem((tx) => this.repo.matchableTenants(tx));
    let posts = 0;
    let matches = 0;
    let batches = 0;
    for (const tenantId of tenants) {
      try {
        await this.asSystem((tx) => this.repo.ensureWatermark(tx, tenantId, grace));
        for (;;) {
          if (batches >= budget.maxBatches) {
            return { rows: posts, capped: true, details: { matches } };
          }
          const done = await this.matchBatch(tenantId, grace, budget.batchSize);
          batches += 1;
          posts += done.posts;
          matches += done.matches;
          if (done.posts < budget.batchSize) break;
        }
      } catch (error) {
        // The tenant (or a post) was deleted while this run was on it: its
        // rows went with it, so there is nothing left to match. Other tenants
        // must not wait for the next run because of it.
        if (!isForeignKeyViolation(error)) throw error;
        this.logger.warn({ tenantId }, 'tenant or post deleted during matching; skipped');
      }
    }
    return { rows: posts, capped: false, details: { matches } };
  }

  /** One batch of one tenant's new posts. Returns how many posts and matches it handled. */
  async matchBatch(
    tenantId: string,
    graceSeconds: number,
    limit: number,
  ): Promise<{ posts: number; matches: number }> {
    const posts = await this.asSystem((tx) =>
      this.repo.newPosts(tx, tenantId, graceSeconds, limit),
    );
    if (posts.length === 0) return { posts: 0, matches: 0 };

    const pairs = await this.asSystem((tx) =>
      this.repo.candidatePairs(
        tx,
        posts.map((p) => p.id),
      ),
    );
    const candidatesBySearch = new Map<string, string[]>();
    for (const { search_id, post_id } of pairs) {
      candidatesBySearch.set(search_id, [...(candidatesBySearch.get(search_id) ?? []), post_id]);
    }
    const searches = await this.asSystem((tx) =>
      this.repo.loadForMatching(tx, [...candidatesBySearch.keys()]),
    );

    const items: {
      searchId: string;
      userId: string;
      criteria: SearchCriteria;
      within: string[];
    }[] = [];
    for (const search of searches) {
      const criteria = await this.criteriaOf(search, tenantId);
      if (criteria === undefined) continue;
      items.push({
        searchId: search.id,
        userId: search.user_id,
        criteria,
        within: candidatesBySearch.get(search.id) ?? [],
      });
    }
    const matched = await this.matcher.matchEach(items);

    const tenantOf = new Map(posts.map((p) => [p.id, p.tenant_id]));
    const rows = items.flatMap((item, i) =>
      (matched[i] ?? []).map((postId) => ({
        searchId: item.searchId,
        userId: item.userId,
        postId,
        postTenantId: tenantOf.get(postId)!,
      })),
    );
    const inserted = await this.asSystem(async (tx) => {
      const n = await this.repo.insertMatches(tx, rows);
      await this.repo.advanceWatermark(tx, tenantId, posts.at(-1)!);
      return n;
    });
    return { posts: posts.length, matches: inserted };
  }

  /**
   * The stored search as criteria. A search that no longer resolves (its
   * category was removed, or its field filters no longer fit the category's
   * schema) is skipped and logged; it is never matched with half its filters.
   */
  private async criteriaOf(
    search: Parameters<typeof savedSearchCriteriaInput>[0] & { id: string },
    tenantId: string,
  ): Promise<SearchCriteria | undefined> {
    try {
      const input = savedSearchCriteriaInput(search, tenantId);
      return (await this.context.run({ role: 'system' }, () => this.criteria.resolve(input)))
        .criteria;
    } catch (error) {
      if (!(error instanceof DomainException)) throw error;
      this.logger.warn(
        { savedSearchId: search.id, code: error.code },
        'saved search no longer resolves; skipped',
      );
      return undefined;
    }
  }

  private asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

/** Postgres 23503, directly or as the cause Drizzle wraps it in. */
function isForeignKeyViolation(error: unknown): boolean {
  const codeOf = (e: unknown) =>
    typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
  return codeOf(error) === '23503' || codeOf(cause) === '23503';
}

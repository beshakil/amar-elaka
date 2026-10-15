import { Injectable } from '@nestjs/common';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { SettingsService } from '../settings/settings.service';
import type {
  ReviewDecisionInput,
  ReviewDecisionResult,
  ReviewQueue,
  ReviewQueueQuery,
} from './dto/reviews.dto';
import { ReviewAuthorUnderLegalHoldException, ReviewNotFoundException } from './reviews.exceptions';
import { ReviewsRepository } from './reviews.repository';

/**
 * The moderators' side of reviews (ADR 061): the queue — reviews the
 * integrity checks held (low trust, burst, shared device, phone pattern,
 * similar text) and published ones somebody reported — and the decision,
 * which writes moderation_actions and closes the reports in the same
 * transaction (decide_review, CLAUDE.md rule 13). And the privacy scrub of
 * an author, platform admins only (scrub_review_author: legal holds first).
 */
@Injectable()
export class ReviewModerationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: ReviewsRepository,
    private readonly settings: SettingsService,
  ) {}

  async queue(query: ReviewQueueQuery): Promise<ReviewQueue> {
    const tenantId = this.tenantId();
    const max = await this.settings.get('moderation_queue_page_size_max', tenantId);
    const limit = Math.min(query.limit ?? max, max);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.queue(tx, query.after, limit + 1),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.review_id,
        storeId: r.store_id,
        storeName: r.store_name,
        rating: r.rating,
        text: r.body,
        status: r.status_code,
        flags: r.flags,
        openReports: r.open_reports,
        reportReasons: r.report_reasons ?? [],
        authorName: r.author_name,
        createdAt: r.created_at,
      })),
      nextAfter: rows.length > limit ? (page[page.length - 1]?.review_id ?? null) : null,
    };
  }

  async decide(reviewId: string, input: ReviewDecisionInput): Promise<ReviewDecisionResult> {
    this.tenantId();
    try {
      return await this.tenantDb.transaction((tx) =>
        this.repo.decide(tx, {
          reviewId,
          decision: input.decision,
          reasonCode: input.reasonCode,
          note: input.note ?? null,
        }),
      );
    } catch (error) {
      if (sqlStateOf(error) === 'AE608') throw new ReviewNotFoundException();
      throw error;
    }
  }

  /** Every review the user wrote, in every tenant: text and photos gone, ratings kept. */
  async scrubAuthor(userId: string, reason: string): Promise<{ scrubbed: number }> {
    try {
      const scrubbed = await this.tenantDb.transaction((tx) =>
        this.repo.scrubAuthor(tx, userId, reason),
      );
      return { scrubbed };
    } catch (error) {
      if (sqlStateOf(error) === 'AE613') throw new ReviewAuthorUnderLegalHoldException();
      throw error;
    }
  }

  private tenantId(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}

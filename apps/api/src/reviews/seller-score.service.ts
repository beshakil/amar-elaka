import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { ReviewsRepository } from './reviews.repository';
import {
  computeSellerScore,
  SELLER_SCORE_ALGORITHM_VERSION,
  SELLER_TIERS,
  type SellerScoreSettings,
  type SellerTier,
} from './seller-score-formula';

/**
 * The seller score (ADR 061), the one implementation every screen reads — the
 * store page, the post detail's seller card, store cards. Cached per store
 * (store_seller_scores); an input changing (a review, an upheld report, a
 * verification) marks it stale in the database, and it expires after
 * seller_score_cache_hours anyway (chat stats move without an event). A
 * stale or missing score is recomputed on read. Runs as `system`: the
 * inputs include reports and chats the reader can't see. Only the tier
 * leaves this service for people to see.
 */
@Injectable()
export class SellerScoreService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: ReviewsRepository,
    private readonly settings: SettingsService,
  ) {}

  /** The tier of each store (all in one tenant). */
  async tiers(tenantId: string, storeIds: readonly string[]): Promise<Map<string, SellerTier>> {
    const unique = [...new Set(storeIds)];
    const cached = await this.asSystem(tenantId, (tx) => this.repo.cachedScores(tx, unique));
    const result = new Map<string, SellerTier>();
    for (const storeId of unique) {
      const row = cached.get(storeId);
      if (row && !row.stale && isTier(row.tier_code)) {
        result.set(storeId, row.tier_code);
        continue;
      }
      const computed = await this.recompute(tenantId, storeId);
      if (computed) result.set(storeId, computed.tier);
    }
    return result;
  }

  async tier(tenantId: string, storeId: string): Promise<SellerTier> {
    return (await this.tiers(tenantId, [storeId])).get(storeId) ?? 'new';
  }

  /** Recompute and store one store's score; undefined when there is no such store. */
  async recompute(
    tenantId: string,
    storeId: string,
  ): Promise<{ score: number; tier: SellerTier } | undefined> {
    const s = await this.weights(tenantId);
    const cacheHours = await this.settings.get('seller_score_cache_hours', tenantId);
    return this.asSystem(tenantId, async (tx) => {
      const inputs = await this.repo.scoreInputs(tx, storeId);
      if (!inputs) return undefined;
      const result = computeSellerScore(
        {
          ratingSum: inputs.rating_sum,
          ratingCount: inputs.rating_count,
          conversations: inputs.conversations,
          answered: inputs.answered,
          medianReplySeconds: inputs.median_reply_seconds,
          storeCreatedAt: inputs.store_created_at,
          verificationLevel: inputs.verification_level,
          upheldReports: inputs.upheld_reports,
        },
        s,
        new Date(),
      );
      await this.repo.saveScore(tx, {
        storeId,
        score: result.score,
        tier: result.tier,
        components: { ...result.components, bayesian_rating: result.bayesian },
        algorithmVersion: SELLER_SCORE_ALGORITHM_VERSION,
        cacheHours,
      });
      return { score: result.score, tier: result.tier };
    });
  }

  private async weights(tenantId: string): Promise<SellerScoreSettings> {
    const n = (key: Parameters<SettingsService['get']>[0]) =>
      this.settings.get(key, tenantId) as Promise<number>;
    const [
      priorMean,
      priorWeight,
      weightRating,
      weightResponseRate,
      weightResponseTime,
      weightAccountAge,
      weightVerification,
      penaltyPerUpheldReport,
      responseTargetMinutes,
      responseMaxMinutes,
      minConversations,
      accountAgeFullMonths,
      minReviewsForTier,
      tierTop,
      tierTrusted,
      tierGood,
    ] = await Promise.all([
      n('seller_score_prior_mean'),
      n('seller_score_prior_weight'),
      n('seller_score_weight_rating'),
      n('seller_score_weight_response_rate'),
      n('seller_score_weight_response_time'),
      n('seller_score_weight_account_age'),
      n('seller_score_weight_verification'),
      n('seller_score_penalty_per_upheld_report'),
      n('seller_score_response_target_minutes'),
      n('seller_score_response_max_minutes'),
      n('seller_score_min_conversations'),
      n('seller_score_account_age_full_months'),
      n('seller_score_min_reviews_for_tier'),
      n('seller_score_tier_top'),
      n('seller_score_tier_trusted'),
      n('seller_score_tier_good'),
    ]);
    return {
      priorMean,
      priorWeight,
      weightRating,
      weightResponseRate,
      weightResponseTime,
      weightAccountAge,
      weightVerification,
      penaltyPerUpheldReport,
      responseTargetMinutes,
      responseMaxMinutes,
      minConversations,
      accountAgeFullMonths,
      minReviewsForTier,
      tierTop,
      tierTrusted,
      tierGood,
    };
  }

  private asSystem<T>(tenantId: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ tenantId, role: 'system' }, () => this.tenantDb.transaction(work));
  }
}

function isTier(value: string): value is SellerTier {
  return (SELLER_TIERS as readonly string[]).includes(value);
}

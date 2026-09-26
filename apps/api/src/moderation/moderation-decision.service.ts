import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { DatabaseTransaction } from '../database/database.client';
import { SettingsService } from '../settings/settings.service';
import { isPriceOutlier, textFlags, type PrefilterFlag } from './prefilter';
import { ModerationRepository } from './moderation.repository';

// settings-exempt: a percentage's denominator, not a threshold
const PERCENT = 100;

export type ForcedReviewReason = 'pre_moderation' | 'outside_boundary' | 'resubmission';
export type QueueReason = ForcedReviewReason | PrefilterFlag | 'low_trust';

export interface SubmissionFacts {
  tenantId: string;
  postId: string;
  authorMemberId: string;
  title: string;
  description: string | null;
  categoryId: string;
  price: string | null;
  /** Reasons a human must look whatever the score (pre-moderated category/tenant, beyond buffer, resubmission). */
  forced: readonly ForcedReviewReason[];
  trustScore: number;
}

export interface SubmissionDecision {
  status: 'live' | 'pending';
  reasons: QueueReason[];
  /** Auto-approved, but drawn for an after-the-fact review. */
  sampled: boolean;
}

/**
 * What happens when a post is submitted (ADR 030):
 *   1. forced review (pre-moderated, beyond buffer, resubmission) → pending
 *   2. any pre-filter flag → pending, flags attached
 *   3. trust ≥ trust_auto_approve_threshold → live (+ moderation_sample_rate_percent
 *      of those still queued for review)
 *   4. otherwise → pending (low_trust)
 * Runs in the author's transaction; the caller files the queue item.
 */
@Injectable()
export class ModerationDecisionService {
  constructor(
    private readonly repo: ModerationRepository,
    private readonly settings: SettingsService,
  ) {}

  async decide(tx: DatabaseTransaction, facts: SubmissionFacts): Promise<SubmissionDecision> {
    const flags = await this.prefilter(tx, facts);
    const reasons: QueueReason[] = [...facts.forced, ...flags];
    if (reasons.length > 0) return { status: 'pending', reasons, sampled: false };

    const threshold = await this.settings.get('trust_auto_approve_threshold', facts.tenantId);
    if (facts.trustScore < threshold)
      return { status: 'pending', reasons: ['low_trust'], sampled: false };

    const rate = await this.settings.get('moderation_sample_rate_percent', facts.tenantId);
    return { status: 'live', reasons: [], sampled: randomInt(PERCENT) < rate };
  }

  async prefilter(tx: DatabaseTransaction, facts: SubmissionFacts): Promise<PrefilterFlag[]> {
    const [keywords, maxLinks, windowHours, factor, minSamples, lookbackDays] = await Promise.all([
      this.settings.get('moderation_banned_keywords', facts.tenantId),
      this.settings.get('moderation_max_links_per_post', facts.tenantId),
      this.settings.get('moderation_duplicate_window_hours', facts.tenantId),
      this.settings.get('moderation_price_outlier_factor', facts.tenantId),
      this.settings.get('moderation_price_min_samples', facts.tenantId),
      this.settings.get('moderation_price_lookback_days', facts.tenantId),
    ]);
    const flags = textFlags({
      title: facts.title,
      description: facts.description,
      bannedKeywords: keywords,
      maxLinks,
    });
    if (await this.repo.hasDuplicate(tx, facts.postId, facts.authorMemberId, windowHours)) {
      flags.push('duplicate');
    }
    if (facts.price !== null) {
      const norm = await this.repo.priceMedian(tx, facts.categoryId, lookbackDays, facts.postId);
      if (
        norm.median !== null &&
        norm.samples >= minSamples &&
        isPriceOutlier(Number(facts.price), norm.median, factor)
      ) {
        flags.push('price_outlier');
      }
    }
    return flags;
  }
}

/**
 * The seller score (ADR 061): 0–100 from the store's smoothed rating, its
 * chat responsiveness, its age, its verification and its upheld reports.
 * Pure, so every weight change can be reasoned about and tested; every
 * weight, prior and threshold is a setting (seller_score_*), never a literal
 * here. Shown to people only as a tier, never as the number.
 */

/** Bump when the formula changes shape, so old and new scores aren't compared. */
// settings-exempt: formula version tag, not a tunable number
export const SELLER_SCORE_ALGORITHM_VERSION = 1;
// settings-exempt: the score's fixed range (a CHECK in 0057)
const SCORE_MAX = 100;
// settings-exempt: the star scale (reviews_rating_ck, 1–5)
const STAR_MIN = 1;
// settings-exempt: see above
const STAR_MAX = 5;
// settings-exempt: calendar unit (30-day months for "account age"), not a threshold
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1_000;
// settings-exempt: unit conversion
const SECONDS_PER_MINUTE = 60;
// settings-exempt: "not enough chats to judge" earns half — a neutral midpoint, not a tunable
const NEUTRAL_SHARE = 0.5;

// The three verification levels as an even ladder; the points are seller_score_weight_verification.
// settings-exempt: phone, the first third of the ladder
const LADDER_PHONE = 1 / 3;
// settings-exempt: identity, two thirds of the ladder
const LADDER_IDENTITY = 2 / 3;
export const VERIFICATION_SHARE: Record<string, number> = {
  phone: LADDER_PHONE,
  identity: LADDER_IDENTITY,
  business: 1,
};

/** `new`: too few reviews to judge; `none`: judged, no badge earned. */
export const SELLER_TIERS = ['top', 'trusted', 'good', 'new', 'none'] as const;
export type SellerTier = (typeof SELLER_TIERS)[number];

export interface SellerScoreInputs {
  ratingSum: number;
  ratingCount: number;
  conversations: number;
  answered: number;
  /** Null when no chat was answered. */
  medianReplySeconds: number | null;
  storeCreatedAt: Date;
  verificationLevel: string;
  upheldReports: number;
}

export interface SellerScoreSettings {
  priorMean: number;
  priorWeight: number;
  weightRating: number;
  weightResponseRate: number;
  weightResponseTime: number;
  weightAccountAge: number;
  weightVerification: number;
  penaltyPerUpheldReport: number;
  responseTargetMinutes: number;
  responseMaxMinutes: number;
  minConversations: number;
  accountAgeFullMonths: number;
  minReviewsForTier: number;
  tierTop: number;
  tierTrusted: number;
  tierGood: number;
}

export type SellerScoreComponents = Record<
  'rating' | 'response_rate' | 'response_time' | 'account_age' | 'verification' | 'upheld_reports',
  number
>;

/**
 * The Bayesian average: the prior mean counted as `priorWeight` reviews, plus
 * the real ones. One 5-star review lands near the prior; fifty 4.6s land
 * near 4.6 — so the second outranks the first.
 */
export function bayesianRating(
  ratingSum: number,
  ratingCount: number,
  priorMean: number,
  priorWeight: number,
): number {
  const weight = priorWeight + ratingCount;
  if (weight <= 0) return priorMean;
  return (priorWeight * priorMean + ratingSum) / weight;
}

function share(value: number, from: number, to: number): number {
  if (to <= from) return value >= to ? 1 : 0;
  return Math.max(0, Math.min(1, (value - from) / (to - from)));
}

export function computeSellerScore(
  inputs: SellerScoreInputs,
  s: SellerScoreSettings,
  now: Date,
): { score: number; tier: SellerTier; components: SellerScoreComponents; bayesian: number } {
  const bayesian = bayesianRating(inputs.ratingSum, inputs.ratingCount, s.priorMean, s.priorWeight);
  const enoughChats = inputs.conversations >= s.minConversations;
  const rate = enoughChats ? inputs.answered / inputs.conversations : NEUTRAL_SHARE;
  const timeShare =
    !enoughChats || inputs.medianReplySeconds === null
      ? NEUTRAL_SHARE
      : 1 -
        share(
          inputs.medianReplySeconds / SECONDS_PER_MINUTE,
          s.responseTargetMinutes,
          s.responseMaxMinutes,
        );
  const months = Math.max(0, (now.getTime() - inputs.storeCreatedAt.getTime()) / MS_PER_MONTH);

  const components: SellerScoreComponents = {
    rating: s.weightRating * share(bayesian, STAR_MIN, STAR_MAX),
    response_rate: s.weightResponseRate * rate,
    response_time: s.weightResponseTime * timeShare,
    account_age: s.weightAccountAge * share(months, 0, s.accountAgeFullMonths),
    verification: s.weightVerification * (VERIFICATION_SHARE[inputs.verificationLevel] ?? 0),
    upheld_reports: -s.penaltyPerUpheldReport * inputs.upheldReports,
  };
  const total = Object.values(components).reduce((sum, v) => sum + v, 0);
  const score = Math.max(0, Math.min(SCORE_MAX, Math.round(total)));
  return { score, tier: tierOf(score, inputs.ratingCount, s), components, bayesian };
}

/** The badge: too few reviews is "new", whatever the score; otherwise by threshold. */
export function tierOf(score: number, reviewCount: number, s: SellerScoreSettings): SellerTier {
  if (reviewCount < s.minReviewsForTier) return 'new';
  if (score >= s.tierTop) return 'top';
  if (score >= s.tierTrusted) return 'trusted';
  if (score >= s.tierGood) return 'good';
  return 'none';
}

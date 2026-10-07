/**
 * The member trust score (ADR 030): a 0–100 sum of weighted inputs. Pure, so
 * every weight change can be reasoned about and tested. The weights are
 * settings (trust_*), never literals here.
 */

/** Bump when the formula changes shape, so old and new scores aren't compared. */
// settings-exempt: formula version tag, not a tunable number
export const TRUST_ALGORITHM_VERSION = 2;
// settings-exempt: the score's fixed range (a CHECK in 0027)
export const TRUST_MIN = 0;
// settings-exempt: see above
export const TRUST_MAX = 100;
// settings-exempt: calendar unit (30-day months for "account age"), not a threshold
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1_000;

export interface TrustInputs {
  approvedPosts: number;
  rejectedPosts: number;
  removedPosts: number;
  upheldReports: number;
  bans: number;
  /** Place edit suggestions a moderator approved (0046). */
  approvedEdits: number;
  phoneVerified: boolean;
  storeVerified: boolean;
  memberSince: Date;
}

export interface TrustWeights {
  base: number;
  perApprovedPost: number;
  maxApprovedPoints: number;
  perRejectedPost: number;
  perRemovedPost: number;
  perUpheldReport: number;
  perAccountMonth: number;
  maxAccountAgePoints: number;
  phoneVerified: number;
  storeVerified: number;
  perBan: number;
  perApprovedEdit: number;
  maxApprovedEditPoints: number;
}

export type TrustComponents = Record<
  | 'base'
  | 'approved_posts'
  | 'approved_edits'
  | 'rejected_posts'
  | 'removed_posts'
  | 'upheld_reports'
  | 'bans'
  | 'account_age'
  | 'phone_verified'
  | 'store_verified',
  number
>;

export function computeTrust(
  inputs: TrustInputs,
  weights: TrustWeights,
  now: Date,
): { score: number; components: TrustComponents } {
  const months = Math.max(
    0,
    Math.floor((now.getTime() - inputs.memberSince.getTime()) / MS_PER_MONTH),
  );
  const components: TrustComponents = {
    base: weights.base,
    approved_posts: Math.min(
      inputs.approvedPosts * weights.perApprovedPost,
      weights.maxApprovedPoints,
    ),
    approved_edits: Math.min(
      inputs.approvedEdits * weights.perApprovedEdit,
      weights.maxApprovedEditPoints,
    ),
    rejected_posts: -inputs.rejectedPosts * weights.perRejectedPost,
    removed_posts: -inputs.removedPosts * weights.perRemovedPost,
    upheld_reports: -inputs.upheldReports * weights.perUpheldReport,
    bans: -inputs.bans * weights.perBan,
    account_age: Math.min(months * weights.perAccountMonth, weights.maxAccountAgePoints),
    phone_verified: inputs.phoneVerified ? weights.phoneVerified : 0,
    store_verified: inputs.storeVerified ? weights.storeVerified : 0,
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score: Math.max(TRUST_MIN, Math.min(TRUST_MAX, Math.round(total))), components };
}

/**
 * When the account-age component next changes: the next 30-day month
 * boundary, until the age points reach their cap (then never). Saved as
 * `next_recompute_at`, so an idle member's score still grows with age — the
 * next read after that instant recomputes it; nothing runs on a schedule.
 */
export function nextAccountAgeStep(
  memberSince: Date,
  weights: Pick<TrustWeights, 'perAccountMonth' | 'maxAccountAgePoints'>,
  now: Date,
): Date | null {
  if (weights.perAccountMonth <= 0) return null;
  const months = Math.max(0, Math.floor((now.getTime() - memberSince.getTime()) / MS_PER_MONTH));
  if (months * weights.perAccountMonth >= weights.maxAccountAgePoints) return null;
  return new Date(memberSince.getTime() + (months + 1) * MS_PER_MONTH);
}

/** Mirrors QUEUE_REASONS / TAKEDOWN_REASONS in apps/api/src/moderation/dto/moderation.dto.ts. */
export const QUEUE_REASONS = [
  'low_trust',
  'pre_moderation',
  'outside_boundary',
  'resubmission',
  'banned_keyword',
  'contact_info',
  'link_spam',
  'duplicate',
  'price_outlier',
  'sample',
  'rereview',
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

export const TAKEDOWN_REASONS = [
  'spam',
  'wrong_category',
  'duplicate',
  'policy_violation',
  'prohibited_item',
  'scam_suspected',
  'poor_quality_listing',
  'contact_info_exposed',
  'other',
  'illegal_content',
  'doxxing',
  'csam',
  'credible_threat',
] as const;
export type TakedownReason = (typeof TAKEDOWN_REASONS)[number];

export function isQueueReason(value: string | undefined): value is QueueReason {
  return value !== undefined && (QUEUE_REASONS as readonly string[]).includes(value);
}

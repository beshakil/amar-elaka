import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { SELLER_TIERS } from '../seller-score-formula';

/** review_eligibility (0057) answers. */
export const ELIGIBILITY_STATUSES = [
  'eligible',
  'already_reviewed',
  'no_contact',
  'too_soon',
  'expired',
  'own_store',
  'store_unavailable',
  'signed_out',
] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];
export const REVIEW_STATUSES = ['pending', 'published', 'hidden', 'removed'] as const;
export const REVIEW_FLAGS = [
  'low_trust',
  'burst',
  'shared_device',
  'phone_pattern',
  'similar_text',
] as const;
/** report_reasons (0010, 0057) that fit a review. */
export const REVIEW_REPORT_REASONS = ['fake_review', 'harassment', 'spam', 'other'] as const;
export const REVIEW_DECISIONS = ['publish', 'hide', 'remove'] as const;
/** moderation_reasons (0010, 0027, 0054, 0057) a moderator may decide a review for. */
export const REVIEW_DECISION_REASONS = [
  'meets_guidelines',
  'fake_review',
  'harassment',
  'spam',
  'policy_violation',
  'illegal_content',
  'doxxing',
] as const;

const uuid = z.string().uuid();
// settings-exempt: the star scale (reviews_rating_ck)
const STAR_MIN = 1;
// settings-exempt: see above
const STAR_MAX = 5;
// settings-exempt: validation ceiling; the real limit is review_photos_max (checked in submit_review)
const PHOTO_IDS_CEILING = 10;

// ---- requests --------------------------------------------------------------

export const storeIdParamSchema = z.object({ id: uuid }).strict();
export class StoreIdParamDto extends createZodDto(storeIdParamSchema) {}

export const reviewIdParamSchema = z.object({ id: uuid }).strict();
export class ReviewIdParamDto extends createZodDto(reviewIdParamSchema) {}

export const storeReviewParamSchema = z.object({ id: uuid, reviewId: uuid }).strict();
export class StoreReviewParamDto extends createZodDto(storeReviewParamSchema) {}

export const reviewImageParamSchema = z.object({ id: uuid, mediaId: uuid }).strict();
export class ReviewImageParamDto extends createZodDto(reviewImageParamSchema) {}

export const reviewPageQuerySchema = z
  .object({
    before: uuid.optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type ReviewPageQuery = z.infer<typeof reviewPageQuerySchema>;
export class ReviewPageQueryDto extends createZodDto(reviewPageQuerySchema) {}

/** Its length limits are settings (review_text_max_length, review_photos_max), checked in the DB. */
export const writeReviewSchema = z
  .object({
    rating: z.number().int().min(STAR_MIN).max(STAR_MAX),
    text: z.string().trim().nullable().optional(),
    photoIds: z.array(uuid).max(PHOTO_IDS_CEILING).default([]),
  })
  .strict();
export type WriteReviewInput = z.infer<typeof writeReviewSchema>;
export class WriteReviewDto extends createZodDto(writeReviewSchema) {}

export const respondSchema = z.object({ text: z.string().trim().min(1) }).strict();
export type RespondInput = z.infer<typeof respondSchema>;
export class RespondDto extends createZodDto(respondSchema) {}

export const reportReviewSchema = z
  .object({
    reasonCode: z.enum(REVIEW_REPORT_REASONS),
    details: z.string().trim().nullable().optional(),
  })
  .strict();
export type ReportReviewInput = z.infer<typeof reportReviewSchema>;
export class ReportReviewDto extends createZodDto(reportReviewSchema) {}

export const reviewImagePresignSchema = z
  .object({
    contentType: z.string().min(1),
    byteSize: z.number().int().positive(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();
export type ReviewImagePresignInput = z.infer<typeof reviewImagePresignSchema>;
export class ReviewImagePresignDto extends createZodDto(reviewImagePresignSchema) {}

export const reviewQueueQuerySchema = z
  .object({
    after: uuid.optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;
export class ReviewQueueQueryDto extends createZodDto(reviewQueueQuerySchema) {}

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    reasonCode: z.enum(REVIEW_DECISION_REASONS),
    note: z.string().trim().nullable().optional(),
  })
  .strict();
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export class ReviewDecisionDto extends createZodDto(reviewDecisionSchema) {}

export const scrubAuthorSchema = z.object({ reason: z.string().trim().min(1) }).strict();
export class ScrubAuthorDto extends createZodDto(scrubAuthorSchema) {}

export const userIdParamSchema = z.object({ userId: uuid }).strict();
export class UserIdParamDto extends createZodDto(userIdParamSchema) {}

// ---- responses -------------------------------------------------------------

const photoSchema = z.object({
  id: z.string(),
  thumbhash: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  cardUrl: z.string().nullable(),
  fullUrl: z.string().nullable(),
});
export type ReviewPhoto = z.infer<typeof photoSchema>;

export const reviewViewSchema = z.object({
  id: z.string(),
  rating: z.number(),
  text: z.string().nullable(),
  /** Null once the author's account was scrubbed (the rating stays); clients say "সাবেক সদস্য". */
  authorName: z.string().nullable(),
  authorRemoved: z.boolean(),
  /** Every review here is backed by a real contact (lead_event). */
  verifiedContact: z.literal(true),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  photos: z.array(photoSchema),
  response: z
    .object({ text: z.string(), createdAt: z.string(), editedAt: z.string().nullable() })
    .nullable(),
});
export type ReviewView = z.infer<typeof reviewViewSchema>;

export const sellerTierSchema = z.enum(SELLER_TIERS);

export const reviewSummarySchema = z.object({
  /** The plain average of published reviews (stores.rating_avg); null with none. */
  average: z.number().nullable(),
  count: z.number(),
  /** Count per star, 1–5. */
  histogram: z.object({
    '1': z.number(),
    '2': z.number(),
    '3': z.number(),
    '4': z.number(),
    '5': z.number(),
  }),
  /** The seller score as a badge (ADR 061); the number itself is never shown. */
  tier: sellerTierSchema,
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const reviewPageSchema = z.object({
  summary: reviewSummarySchema,
  items: z.array(reviewViewSchema),
  nextBefore: z.string().nullable(),
});
export type ReviewPage = z.infer<typeof reviewPageSchema>;
export class ReviewPageDto extends createZodDto(reviewPageSchema) {}

export const myReviewSchema = z.object({
  id: z.string(),
  rating: z.number(),
  text: z.string().nullable(),
  status: z.enum(REVIEW_STATUSES),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  editableUntil: z.string(),
  photos: z.array(photoSchema),
});
export type MyReview = z.infer<typeof myReviewSchema>;

export const eligibilitySchema = z.object({
  status: z.enum(ELIGIBILITY_STATUSES),
  /** too_soon: when it opens; eligible: when it closes. */
  eligibleAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  myReview: myReviewSchema.nullable(),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;
export class EligibilityDto extends createZodDto(eligibilitySchema) {}

export const writeResultSchema = z.object({
  review: myReviewSchema,
  /** pending: it waits for a moderator (the integrity checks); the author is told. */
  needsReview: z.boolean(),
});
export type WriteResult = z.infer<typeof writeResultSchema>;
export class WriteResultDto extends createZodDto(writeResultSchema) {}

export const respondResultSchema = z.object({ created: z.boolean() });
export class RespondResultDto extends createZodDto(respondResultSchema) {}

export const reportResultSchema = z.object({ reportId: z.string(), created: z.boolean() });
export type ReportResult = z.infer<typeof reportResultSchema>;
export class ReviewReportResultDto extends createZodDto(reportResultSchema) {}

export const reviewImagePresignedSchema = z.object({
  mediaId: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    expiresInSeconds: z.number(),
  }),
});
export type ReviewImagePresigned = z.infer<typeof reviewImagePresignedSchema>;
export class ReviewImagePresignedDto extends createZodDto(reviewImagePresignedSchema) {}

export const reviewImageStatusSchema = z.object({
  mediaId: z.string(),
  status: z.enum(['pending_upload', 'processing', 'ready', 'rejected', 'quarantined']),
});
export type ReviewImageStatus = z.infer<typeof reviewImageStatusSchema>;
export class ReviewImageStatusDto extends createZodDto(reviewImageStatusSchema) {}

export const reviewQueueItemSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  storeName: z.string(),
  rating: z.number(),
  text: z.string().nullable(),
  status: z.enum(REVIEW_STATUSES),
  flags: z.array(z.enum(REVIEW_FLAGS)),
  openReports: z.number(),
  reportReasons: z.array(z.string()),
  authorName: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;
export const reviewQueueSchema = z.object({
  items: z.array(reviewQueueItemSchema),
  nextAfter: z.string().nullable(),
});
export type ReviewQueue = z.infer<typeof reviewQueueSchema>;
export class ReviewModerationQueueDto extends createZodDto(reviewQueueSchema) {}

export const reviewDecisionResultSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  reportsClosed: z.number(),
});
export type ReviewDecisionResult = z.infer<typeof reviewDecisionResultSchema>;
export class ReviewDecisionResultDto extends createZodDto(reviewDecisionResultSchema) {}

export const scrubResultSchema = z.object({ scrubbed: z.number() });
export class ScrubResultDto extends createZodDto(scrubResultSchema) {}

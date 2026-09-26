import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

// ADR 005 takedown reasons (lookup moderation_reasons). `meets_guidelines`
// is the approval reason; the serious ones need hard removal / legal hold.
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

const reasonText = z.string().trim().min(1);

export const queueQuerySchema = z
  .object({
    reason: z.enum(QUEUE_REASONS).optional(),
    categoryId: z.string().uuid().optional(),
    /** Only items at least this many hours old. */
    olderThanHours: z.coerce.number().int().nonnegative().optional(),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type QueueQuery = z.infer<typeof queueQuerySchema>;
export class QueueQueryDto extends createZodDto(queueQuerySchema) {}

export const moderationPostParamSchema = z.object({ id: z.string().uuid() });
export class ModerationPostParamDto extends createZodDto(moderationPostParamSchema) {}

export const decisionSchema = z
  .object({ reasonCode: z.enum(TAKEDOWN_REASONS), reasonText: reasonText.optional() })
  .strict();
export type DecisionInput = z.infer<typeof decisionSchema>;
export class DecisionDto extends createZodDto(decisionSchema) {}

export const hardRemoveSchema = z
  .object({
    reasonCode: z.enum(TAKEDOWN_REASONS),
    reasonText,
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
export type HardRemoveInput = z.infer<typeof hardRemoveSchema>;
export class HardRemoveDto extends createZodDto(hardRemoveSchema) {}

export const bulkSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    postIds: z.array(z.string().uuid()).min(1),
    reasonCode: z.enum(TAKEDOWN_REASONS).optional(),
    reasonText: reasonText.optional(),
  })
  .strict()
  .refine((value) => value.action !== 'reject' || value.reasonCode !== undefined, {
    message: 'reasonCode is required to reject',
    path: ['reasonCode'],
  });
export type BulkInput = z.infer<typeof bulkSchema>;
export class BulkDto extends createZodDto(bulkSchema) {}

// ---- responses -------------------------------------------------------------

export const queueItemSchema = z.object({
  id: z.string(),
  postId: z.string(),
  source: z.enum(['submission', 'sample', 'rereview']),
  reasons: z.array(z.string()),
  postStatus: z.string(),
  title: z.string(),
  category: z.object({ id: z.string(), name: z.object({ bn: z.string(), en: z.string() }) }),
  price: z.string().nullable(),
  outsideBoundary: z.boolean(),
  mediaCount: z.number(),
  authorTrustScore: z.number().nullable(),
  queuedAt: z.string(),
  ageHours: z.number(),
});
export const queuePageSchema = z.object({
  items: z.array(queueItemSchema),
  nextCursor: z.string().nullable(),
});
export type QueuePage = z.infer<typeof queuePageSchema>;
export class QueuePageDto extends createZodDto(queuePageSchema) {}

export const moderationResultSchema = z.object({
  postId: z.string(),
  status: z.string(),
  scrubbed: z.boolean(),
});
export type ModerationResult = z.infer<typeof moderationResultSchema>;
export class ModerationResultDto extends createZodDto(moderationResultSchema) {}

export const bulkResultSchema = z.object({
  results: z.array(
    z.object({
      postId: z.string(),
      ok: z.boolean(),
      status: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
export class BulkResultDto extends createZodDto(bulkResultSchema) {}

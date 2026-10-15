import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

/** The badge levels (ADR 062), lowest first. `none`: not even the phone. */
export const VERIFICATION_LEVELS = [
  'none',
  'phone_verified',
  'identity_checked',
  'business_verified',
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
export const VERIFICATION_STATUSES = [
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'expired',
  'revoked',
] as const;
export const REJECTION_REASONS = [
  'document_unclear',
  'document_expired',
  'name_mismatch',
  'suspected_fraud',
  'duplicate_submission',
  'other',
] as const;
export const EVIDENCE_KINDS = ['selfie', 'trade_licence', 'shop_front', 'visit_photo'] as const;
export const DECISIONS = ['approve', 'reject', 'request_visit'] as const;
/** verification_can_request (0058). */
export const REQUEST_STATES = ['ok', 'open_request', 'already_verified'] as const;

const uuid = z.string().uuid();
// settings-exempt: a validation ceiling on raw input; the NID's real shape is checked by normalizeNid
const NID_INPUT_MAX = 40;
// settings-exempt: a validation ceiling on a moderator's note, not a business rule
const NOTE_MAX = 2000;

// ---- requests --------------------------------------------------------------

export const idParamSchema = z.object({ id: uuid }).strict();
export class VerificationIdParamDto extends createZodDto(idParamSchema) {}

export const storeIdParamSchema = z.object({ id: uuid }).strict();
export class VerificationStoreParamDto extends createZodDto(storeIdParamSchema) {}

export const mediaParamSchema = z.object({ mediaId: uuid }).strict();
export class EvidenceMediaParamDto extends createZodDto(mediaParamSchema) {}

export const storeMediaParamSchema = z.object({ id: uuid, mediaId: uuid }).strict();
export class StoreEvidenceMediaParamDto extends createZodDto(storeMediaParamSchema) {}

/**
 * The NID number travels only in this body, over TLS; the API hashes it at
 * once (nid.ts) and never stores, logs or returns it.
 */
export const identitySchema = z
  .object({
    nid: z.string().min(1).max(NID_INPUT_MAX),
    selfieMediaId: uuid,
  })
  .strict();
export type IdentityInput = z.infer<typeof identitySchema>;
export class SubmitIdentityDto extends createZodDto(identitySchema) {}

export const businessSchema = z
  .object({
    licenceMediaId: uuid,
    shopFrontMediaId: uuid,
  })
  .strict();
export type BusinessInput = z.infer<typeof businessSchema>;
export class SubmitBusinessDto extends createZodDto(businessSchema) {}

export const evidencePresignSchema = z
  .object({
    contentType: z.string().min(1),
    byteSize: z.number().int().positive(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();
export type EvidencePresignInput = z.infer<typeof evidencePresignSchema>;
export class EvidencePresignDto extends createZodDto(evidencePresignSchema) {}

export const queueQuerySchema = z
  .object({
    after: uuid.optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type QueueQuery = z.infer<typeof queueQuerySchema>;
export class VerificationQueueQueryDto extends createZodDto(queueQuerySchema) {}

export const decisionSchema = z
  .object({
    decision: z.enum(DECISIONS),
    rejectionReason: z.enum(REJECTION_REASONS).optional(),
    note: z.string().trim().max(NOTE_MAX).nullable().optional(),
    /** Approve only: an earlier end than the level's validity (e.g. the trade licence's). */
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type DecisionInput = z.infer<typeof decisionSchema>;
export class VerificationDecisionDto extends createZodDto(decisionSchema) {}

// ---- responses -------------------------------------------------------------

export const myVerificationSchema = z.object({
  id: z.string(),
  subjectType: z.enum(['member', 'store']),
  subjectId: z.string(),
  level: z.enum(['identity_checked', 'business_verified']),
  status: z.enum(VERIFICATION_STATUSES),
  rejectionReason: z.enum(REJECTION_REASONS).nullable(),
  note: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MyVerification = z.infer<typeof myVerificationSchema>;

export const myVerificationsSchema = z.object({
  /** The caller's own badge, everywhere. */
  level: z.enum(VERIFICATION_LEVELS),
  /** Whether a new identity request can be made now (open one waiting, or valid beyond the renewal window). */
  identityRequest: z.enum(REQUEST_STATES),
  items: z.array(myVerificationSchema),
});
export type MyVerifications = z.infer<typeof myVerificationsSchema>;
export class MyVerificationsDto extends createZodDto(myVerificationsSchema) {}

export const storeVerificationSchema = z.object({
  level: z.enum(VERIFICATION_LEVELS),
  request: z.enum(REQUEST_STATES),
  /** The owner's identity is a precondition of business verification. */
  ownerIdentityChecked: z.boolean(),
  items: z.array(myVerificationSchema),
});
export type StoreVerification = z.infer<typeof storeVerificationSchema>;
export class StoreVerificationDto extends createZodDto(storeVerificationSchema) {}

export const submittedSchema = z.object({ id: z.string(), status: z.literal('submitted') });
export class VerificationSubmittedDto extends createZodDto(submittedSchema) {}

export const evidencePresignedSchema = z.object({
  mediaId: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    expiresInSeconds: z.number(),
  }),
});
export type EvidencePresigned = z.infer<typeof evidencePresignedSchema>;
export class EvidencePresignedDto extends createZodDto(evidencePresignedSchema) {}

export const evidenceStatusSchema = z.object({
  mediaId: z.string(),
  status: z.enum(['pending_upload', 'processing', 'ready', 'rejected', 'quarantined']),
});
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export class EvidenceStatusDto extends createZodDto(evidenceStatusSchema) {}

export const queueItemSchema = z.object({
  id: z.string(),
  subjectType: z.enum(['member', 'store']),
  subjectId: z.string(),
  subjectName: z.string().nullable(),
  level: z.enum(['identity_checked', 'business_verified']),
  status: z.enum(VERIFICATION_STATUSES),
  nidLast3: z.string().nullable(),
  nidDuplicate: z.boolean(),
  visitStatus: z.enum(['not_needed', 'requested', 'done']),
  evidenceCount: z.number(),
  createdAt: z.string(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;
export const queueSchema = z.object({
  items: z.array(queueItemSchema),
  nextAfter: z.string().nullable(),
});
export type VerificationQueue = z.infer<typeof queueSchema>;
export class VerificationQueueDto extends createZodDto(queueSchema) {}

export const evidenceViewSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  mimeType: z.string().nullable(),
  /** A short-lived signed URL (verification_doc_url_ttl_seconds); null once purged. */
  url: z.string().nullable(),
  /** A smaller signed image for the side-by-side view (photos only). */
  previewUrl: z.string().nullable(),
  purged: z.boolean(),
});
export const detailSchema = queueItemSchema.extend({
  note: z.string().nullable(),
  rejectionReason: z.enum(REJECTION_REASONS).nullable(),
  expiresAt: z.string().nullable(),
  documentsPurged: z.boolean(),
  /** A store's owner's own level (business needs identity first). */
  ownerLevel: z.enum(VERIFICATION_LEVELS).nullable(),
  urlExpiresInSeconds: z.number(),
  evidence: z.array(evidenceViewSchema),
  history: z.array(
    z.object({
      id: z.string(),
      status: z.enum(VERIFICATION_STATUSES),
      createdAt: z.string(),
      reviewedAt: z.string().nullable(),
      rejectionReason: z.string().nullable(),
    }),
  ),
});
export type VerificationDetail = z.infer<typeof detailSchema>;
export class VerificationDetailDto extends createZodDto(detailSchema) {}

export const decisionResultSchema = z.object({
  status: z.enum(VERIFICATION_STATUSES),
  expiresAt: z.string().nullable(),
});
export type DecisionResult = z.infer<typeof decisionResultSchema>;
export class VerificationDecisionResultDto extends createZodDto(decisionResultSchema) {}

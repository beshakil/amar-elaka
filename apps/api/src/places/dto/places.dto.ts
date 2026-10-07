import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { specialDayViewSchema } from '../../hours/dto/hours.dto';
import { openStateSchema } from '../../hours/open-state';
import { TAKEDOWN_REASONS } from '../../moderation/dto/moderation.dto';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: ISO weekdays, Monday = 1 … Sunday = 7.
const ISO_DAYS = 7;
// settings-exempt: abuse bound on input size (a few opening ranges per day), not a business rule.
const MAX_HOURS_RANGES = 28;

export const PLACE_STATUSES = [
  'pending_review',
  'published',
  'temporarily_closed',
  'permanently_closed',
  'rejected',
] as const;
export const CLAIM_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn', 'revoked'] as const;
export const REVISION_KINDS = ['created', 'edited', 'claimed', 'reverted'] as const;

// Lengths are checked against place_name_max_length in the service (rule 9).
const name = z.string().trim().min(1);
const optionalText = z.string().trim().min(1);
/** A Bangladeshi mobile number; normalised to E.164 by the service. */
const phone = z.string().trim().min(1);
const location = z.object({
  lat: z.number().min(-MAX_LAT).max(MAX_LAT),
  lng: z.number().min(-MAX_LNG).max(MAX_LNG),
});
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 09:30');

/**
 * Weekly opening hours: one entry per opening range. `closes` at or before
 * `opens` means it closes after midnight. A day without an entry is closed.
 */
const businessHours = z
  .array(
    z
      .object({
        day: z.number().int().min(1).max(ISO_DAYS),
        opens: clock,
        closes: clock,
      })
      .strict(),
  )
  .max(MAX_HOURS_RANGES);
export type BusinessHoursInput = z.infer<typeof businessHours>;

export const createPlaceSchema = z
  .object({
    nameBn: name,
    nameEn: name.optional(),
    /** A place-kind category enabled in the place's area. */
    categoryId: z.string().uuid(),
    location,
    phone: phone.optional(),
    /** Ready images from POST /media/presign + confirm, in display order. */
    photos: z.array(z.string().uuid()).default([]),
    /** One image of the shop front as seen from the street. */
    streetPhoto: z.string().uuid().optional(),
    businessHours: businessHours.optional(),
    addressText: optionalText.optional(),
    description: optionalText.optional(),
    /** Moderators only (403 otherwise). */
    isLandmark: z.boolean().optional(),
    landmarkRadiusKm: z.number().positive().optional(),
    /**
     * After a 409 PLACE_LIKELY_DUPLICATE: "no, it's a different place" —
     * add it anyway (the pair still goes to a moderator).
     */
    confirmNotDuplicate: z.boolean().default(false),
  })
  .strict();
export type CreatePlaceInput = z.infer<typeof createPlaceSchema>;
export class CreatePlaceDto extends createZodDto(createPlaceSchema) {}

export const updatePlaceSchema = z
  .object({
    nameBn: name,
    nameEn: name.nullable(),
    categoryId: z.string().uuid(),
    location,
    phones: z.array(phone),
    businessHours,
    addressText: optionalText.nullable(),
    description: optionalText.nullable(),
    /** published ↔ temporarily_closed ↔ permanently_closed. */
    status: z.enum(['published', 'temporarily_closed', 'permanently_closed']),
    isLandmark: z.boolean(),
    landmarkRadiusKm: z.number().positive().nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.');
export type UpdatePlaceInput = z.infer<typeof updatePlaceSchema>;
export class UpdatePlaceDto extends createZodDto(updatePlaceSchema) {}

export const placeIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class PlaceIdParamDto extends createZodDto(placeIdParamSchema) {}

export const revisionParamSchema = z
  .object({ id: z.string().uuid(), revisionId: z.string().uuid() })
  .strict();
export class RevisionParamDto extends createZodDto(revisionParamSchema) {}

export const pageQuerySchema = z
  .object({
    /** The `nextCursor` of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuerySchema>;
export class PageQueryDto extends createZodDto(pageQuerySchema) {}

const reasonText = z.string().trim().min(1);

export const placeDecisionSchema = z
  .object({ reasonCode: z.enum(TAKEDOWN_REASONS), reasonText: reasonText.optional() })
  .strict();
export type PlaceDecisionInput = z.infer<typeof placeDecisionSchema>;
export class PlaceDecisionDto extends createZodDto(placeDecisionSchema) {}

// ---- claims ----------------------------------------------------------------

export const claimOtpSchema = z
  .object({
    /** Which of the place's phone numbers gets the code (default: the first). */
    phoneIndex: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ClaimOtpInput = z.infer<typeof claimOtpSchema>;
export class ClaimOtpDto extends createZodDto(claimOtpSchema) {}

/**
 * At least one kind of evidence; which kinds a tenant accepts is the
 * place_claim_evidence_methods setting. Photos and licence pages are
 * uploaded as kind `document` (private storage) before claiming.
 */
export const createClaimSchema = z
  .object({
    evidence: z
      .object({
        otp: z
          .object({
            code: z.string().regex(/^\d+$/, 'digits only'),
            phoneIndex: z.number().int().nonnegative().default(0),
          })
          .strict()
          .optional(),
        shopFrontPhotos: z.array(z.string().uuid()).optional(),
        tradeLicence: z.array(z.string().uuid()).optional(),
      })
      .strict()
      .refine(
        (e) =>
          e.otp !== undefined ||
          (e.shopFrontPhotos?.length ?? 0) > 0 ||
          (e.tradeLicence?.length ?? 0) > 0,
        'Offer at least one kind of evidence.',
      ),
    note: optionalText.optional(),
  })
  .strict();
export type CreateClaimInput = z.infer<typeof createClaimSchema>;
export class CreateClaimDto extends createZodDto(createClaimSchema) {}

export const claimIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class ClaimIdParamDto extends createZodDto(claimIdParamSchema) {}

export const approveClaimSchema = z
  .object({
    /** Link this existing store of the claimant's instead of creating one. */
    storeId: z.string().uuid().optional(),
    note: optionalText.optional(),
  })
  .strict();
export type ApproveClaimInput = z.infer<typeof approveClaimSchema>;
export class ApproveClaimDto extends createZodDto(approveClaimSchema) {}

export const rejectClaimSchema = z
  .object({
    reasonCode: z.enum([...TAKEDOWN_REASONS, 'place_already_claimed']),
    reasonText: reasonText.optional(),
  })
  .strict();
export type RejectClaimInput = z.infer<typeof rejectClaimSchema>;
export class RejectClaimDto extends createZodDto(rejectClaimSchema) {}

// ---- responses -------------------------------------------------------------

const photoSchema = z.object({
  id: z.string(),
  thumbhash: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  cardUrl: z.string().nullable(),
  fullUrl: z.string().nullable(),
});

const hoursSchema = z.object({
  day: z.number(),
  opens: z.string(),
  closes: z.string(),
  closesNextDay: z.boolean(),
});

export const placeSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(PLACE_STATUSES),
  categoryId: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string().nullable(),
  description: z.string().nullable(),
  phones: z.array(z.string()),
  addressText: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  geoAreaId: z.string().nullable(),
  outsideBoundary: z.boolean(),
  isLandmark: z.boolean(),
  landmarkRadiusKm: z.number().nullable(),
  source: z.string(),
  fieldVerified: z.boolean(),
  photos: z.array(photoSchema),
  streetPhoto: photoSchema.nullable(),
  businessHours: z.array(hoursSchema),
  /** Claimed = an owner verified it; storeId = the store whose map pin this is. */
  claim: z.object({ claimed: z.boolean(), storeId: z.string().nullable() }),
  rating: z.object({ avg: z.number().nullable(), count: z.number() }),
  /** The caller contributed it. */
  isMine: z.boolean(),
  /** The caller may PATCH it (staff, agents, the claimed owner). */
  canEdit: z.boolean(),
  /** Set when the requested place was merged into this one (a redirect). */
  redirectedFrom: z.string().nullable(),
  /** is_open_at() now (ADR 049): open | closes_soon | opens_soon | closed | unknown, and the next change. */
  openState: openStateSchema.nullable(),
  /** Holidays and days with their own hours, from today (local) on. */
  specialDays: z.array(specialDayViewSchema),
  /** The owner's "closed today", until this instant; null when not set. */
  closedUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlaceView = z.infer<typeof placeSchema>;
export class PlaceDto extends createZodDto(placeSchema) {}

export const revisionSchema = z.object({
  id: z.string(),
  kind: z.enum(REVISION_KINDS),
  /** {field: {from, to}}; `hours` holds the whole week before and after. */
  changedFields: z.record(z.object({ from: z.unknown(), to: z.unknown() })),
  changedByUserId: z.string().nullable(),
  revertsRevisionId: z.string().nullable(),
  createdAt: z.string(),
});
export type RevisionView = z.infer<typeof revisionSchema>;

export const revisionPageSchema = z.object({
  items: z.array(revisionSchema),
  nextCursor: z.string().nullable(),
});
export type RevisionPage = z.infer<typeof revisionPageSchema>;
export class RevisionPageDto extends createZodDto(revisionPageSchema) {}

export const revertResultSchema = z.object({
  placeId: z.string(),
  /** The new `reverted` revision. */
  revisionId: z.string().nullable(),
});
export type RevertResult = z.infer<typeof revertResultSchema>;
export class RevertResultDto extends createZodDto(revertResultSchema) {}

export const reviewQueueItemSchema = z.object({
  id: z.string(),
  nameBn: z.string(),
  nameEn: z.string().nullable(),
  categoryId: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  outsideBoundary: z.boolean(),
  photoCount: z.number(),
  createdByUserId: z.string().nullable(),
  queuedAt: z.string(),
});
export const reviewQueueSchema = z.object({
  items: z.array(reviewQueueItemSchema),
  nextCursor: z.string().nullable(),
});
export type ReviewQueuePage = z.infer<typeof reviewQueueSchema>;
export class ReviewQueueDto extends createZodDto(reviewQueueSchema) {}

export const placeDecisionResultSchema = z.object({
  placeId: z.string(),
  status: z.enum(PLACE_STATUSES),
});
export type PlaceDecisionResult = z.infer<typeof placeDecisionResultSchema>;
export class PlaceDecisionResultDto extends createZodDto(placeDecisionResultSchema) {}

export const claimOtpSentSchema = z.object({
  /** The number the code went to, masked (+8801••••••678). */
  sentTo: z.string(),
  resendAfterSeconds: z.number(),
});
export type ClaimOtpSent = z.infer<typeof claimOtpSentSchema>;
export class ClaimOtpSentDto extends createZodDto(claimOtpSentSchema) {}

export const claimSchema = z.object({
  id: z.string(),
  placeId: z.string(),
  status: z.enum(CLAIM_STATUSES),
  evidence: z.array(z.string()),
  otpVerified: z.boolean(),
  /** The store the approval created or linked. */
  storeId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type ClaimView = z.infer<typeof claimSchema>;
export class ClaimDto extends createZodDto(claimSchema) {}

export const claimQueueItemSchema = z.object({
  id: z.string(),
  place: z.object({
    id: z.string(),
    nameBn: z.string(),
    phones: z.array(z.string()),
  }),
  claimantMemberId: z.string(),
  claimantUserId: z.string().nullable(),
  evidence: z.array(z.string()),
  otpVerifiedPhone: z.string().nullable(),
  /** Private evidence files (media ids) attached to the claim. */
  documentIds: z.array(z.string()),
  note: z.string().nullable(),
  /** Other pending claims on the same place. */
  competingClaims: z.number(),
  queuedAt: z.string(),
});
export const claimQueueSchema = z.object({
  items: z.array(claimQueueItemSchema),
  nextCursor: z.string().nullable(),
});
export type ClaimQueuePage = z.infer<typeof claimQueueSchema>;
export class ClaimQueueDto extends createZodDto(claimQueueSchema) {}

export const claimDecisionResultSchema = z.object({
  claimId: z.string(),
  status: z.enum(CLAIM_STATUSES),
  storeId: z.string().nullable(),
  /** Pending claims on the same place that the approval rejected. */
  supersededClaimIds: z.array(z.string()),
});
export type ClaimDecisionResult = z.infer<typeof claimDecisionResultSchema>;
export class ClaimDecisionResultDto extends createZodDto(claimDecisionResultSchema) {}

// ---- duplicates and merging (ADR 048) ---------------------------------------

export const duplicateQuerySchema = z
  .object({
    status: z.enum(['open', 'merged', 'dismissed']).default('open'),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type DuplicateQuery = z.infer<typeof duplicateQuerySchema>;
export class DuplicateQueryDto extends createZodDto(duplicateQuerySchema) {}

export const duplicateIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class DuplicateIdParamDto extends createZodDto(duplicateIdParamSchema) {}

export const mergeParamSchema = z
  .object({ id: z.string().uuid(), targetId: z.string().uuid() })
  .strict();
export class MergeParamDto extends createZodDto(mergeParamSchema) {}

export const mergeIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class MergeIdParamDto extends createZodDto(mergeIdParamSchema) {}

export const duplicateItemSchema = z.object({
  id: z.string(),
  entityType: z.enum(['place', 'store']),
  /** The entity flagged (in this tenant). */
  entity: z.object({ id: z.string(), nameBn: z.string().nullable() }),
  /** The existing one it resembles; possibly in a neighbouring area (name then null). */
  candidate: z.object({ id: z.string(), tenantId: z.string(), nameBn: z.string().nullable() }),
  score: z.number(),
  classification: z.enum(['likely', 'possible']),
  signals: z.record(z.unknown()),
  source: z.enum(['create', 'batch']),
  status: z.enum(['open', 'merged', 'dismissed']),
  createdAt: z.string(),
});
export const duplicatePageSchema = z.object({
  items: z.array(duplicateItemSchema),
  nextCursor: z.string().nullable(),
});
export type DuplicatePage = z.infer<typeof duplicatePageSchema>;
export class DuplicatePageDto extends createZodDto(duplicatePageSchema) {}

export const mergeResultSchema = z.object({
  mergeId: z.string(),
  loserPlaceId: z.string(),
  targetPlaceId: z.string(),
  /** Until when POST /place-merges/:id/undo works. */
  undoUntil: z.string(),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;
export class MergeResultDto extends createZodDto(mergeResultSchema) {}

export const undoResultSchema = z.object({ mergeId: z.string(), restoredPlaceId: z.string() });
export type UndoResult = z.infer<typeof undoResultSchema>;
export class UndoResultDto extends createZodDto(undoResultSchema) {}

import { z } from 'zod';
import { phoneSchema } from '../../auth/dto/phone.schema';
import { createZodDto } from '../../common/pipes/zod-dto';

/** Bans, appeals, the blacklist and complaints (ADR 063). Codes mirror the 0010/0059 lookups. */
export const BAN_SEVERITIES = ['restricted', 'banned'] as const;
export const BAN_REASONS = [
  'scam',
  'harassment',
  'spam',
  'fake_listings',
  'payment_fraud',
  'identity_fraud',
  'repeated_violations',
  'other',
] as const;
export const BLACKLIST_REASONS = [
  'advance_payment_scam',
  'fake_product',
  'identity_fraud',
  'harassment',
  'payment_fraud',
] as const;
export const BLACKLIST_SEVERITIES = ['watch', 'restricted', 'banned', 'terminated'] as const;
export const BLACKLIST_STATUSES = [
  'recommended',
  'active',
  'rejected',
  'revoked',
  'expired',
] as const;
export const BAN_STATUSES = ['active', 'expired', 'revoked', 'superseded'] as const;
export const APPEAL_STATUSES = [
  'submitted',
  'in_review',
  'escalated',
  'upheld',
  'granted',
  'reduced',
  'withdrawn',
] as const;
export const APPEAL_DECISIONS = ['grant', 'reduce', 'uphold'] as const;
export const EVIDENCE_TYPES = [
  'report',
  'message',
  'post',
  'review',
  'payment',
  'media_asset',
  'support_ticket',
  'complaint',
  'conversation',
] as const;
export const COMPLAINT_CATEGORIES = ['fake_seller', 'scam', 'abuse', 'other'] as const;
export const COMPLAINT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const COMPLAINT_STATUSES = ['pending', 'in_progress', 'resolved'] as const;

const uuid = z.string().uuid();
// settings-exempt: a validation ceiling on raw input; the real limits are settings checked by the database
const TEXT_INPUT_MAX = 10000;
// settings-exempt: a validation ceiling on how many evidence references one request carries
const EVIDENCE_MAX = 20;
// settings-exempt: a shape ceiling on a reference code ("BN-" + 10 characters)
const REFERENCE_MAX = 20;

const text = z.string().trim().min(1).max(TEXT_INPUT_MAX);
const evidence = z
  .array(z.object({ type: z.enum(EVIDENCE_TYPES), id: uuid }).strict())
  .max(EVIDENCE_MAX);
const paging = {
  after: uuid.optional(),
  limit: z.coerce.number().int().positive().optional(),
};
// Same shape check as the login OTP (otp-verify.dto.ts); OtpService compares hashes.
const otpCode = z.string().regex(/^\d{4,8}$/, 'Enter the code exactly as received.');

// ---- params ------------------------------------------------------------------

export class BanIdParamDto extends createZodDto(z.object({ id: uuid }).strict()) {}
export class AppealIdParamDto extends createZodDto(z.object({ id: uuid }).strict()) {}
export class BlacklistIdParamDto extends createZodDto(z.object({ id: uuid }).strict()) {}
export class ComplaintIdParamDto extends createZodDto(z.object({ id: uuid }).strict()) {}

// ---- bans --------------------------------------------------------------------

export const issueBanSchema = z
  .object({
    userId: uuid,
    severity: z.enum(BAN_SEVERITIES),
    reasonCode: z.enum(BAN_REASONS),
    /** Internal and factual; the person sees only the reason code. */
    reasonText: text,
    evidence: evidence.default([]),
    /** Off the ladder (ban_ladder_days) only with overrideReason. */
    durationDays: z.number().int().positive().optional(),
    permanent: z.boolean().optional(),
    overrideReason: z.string().trim().max(TEXT_INPUT_MAX).optional(),
    /** Resolve this complaint with the ban (optional). */
    complaintId: uuid.optional(),
  })
  .strict();
export type IssueBanInput = z.infer<typeof issueBanSchema>;
export class IssueBanDto extends createZodDto(issueBanSchema) {}

export const liftBanSchema = z.object({ reason: text }).strict();
export class LiftBanDto extends createZodDto(liftBanSchema) {}

export const banListQuerySchema = z
  .object({ active: z.enum(['true', 'false']).optional(), ...paging })
  .strict();
export type BanListQuery = z.infer<typeof banListQuerySchema>;
export class BanListQueryDto extends createZodDto(banListQuerySchema) {}

export const banMemberQuerySchema = z.object({ phone: phoneSchema }).strict();
export class BanMemberQueryDto extends createZodDto(banMemberQuerySchema) {}

// ---- appeals -------------------------------------------------------------------

export const accountAppealSchema = z.object({ targetId: uuid, statement: text }).strict();
export type AccountAppealInput = z.infer<typeof accountAppealSchema>;
export class AccountAppealSubmitDto extends createZodDto(accountAppealSchema) {}

export const appealOtpRequestSchema = z.object({ phone: phoneSchema }).strict();
export class AppealOtpRequestDto extends createZodDto(appealOtpRequestSchema) {}

/** POST, not GET: the OTP never goes into a URL or an access log (§9.10). */
export const appealStatusRequestSchema = z.object({ phone: phoneSchema, otp: otpCode }).strict();
export class AppealStatusRequestDto extends createZodDto(appealStatusRequestSchema) {}

export const publicAppealSubmitSchema = z
  .object({
    phone: phoneSchema,
    /** One of the two: the SMS code, or the appeal-only token /appeals/status returned. */
    otp: otpCode.optional(),
    appealToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,100}$/)
      .optional(),
    reference: z.string().trim().min(1).max(REFERENCE_MAX),
    statement: text,
  })
  .strict();
export type PublicAppealSubmitInput = z.infer<typeof publicAppealSubmitSchema>;
export class PublicAppealSubmitDto extends createZodDto(publicAppealSubmitSchema) {}

export const appealQueueQuerySchema = z.object({ ...paging }).strict();
export type AppealQueueQuery = z.infer<typeof appealQueueQuerySchema>;
export class AppealQueueQueryDto extends createZodDto(appealQueueQuerySchema) {}

export const appealDecisionSchema = z
  .object({
    decision: z.enum(APPEAL_DECISIONS),
    note: z.string().trim().max(TEXT_INPUT_MAX).optional(),
    /** reduce: the new, earlier end. */
    reducedUntil: z.string().datetime().optional(),
  })
  .strict();
export type AppealDecisionInput = z.infer<typeof appealDecisionSchema>;
export class AppealDecisionDto extends createZodDto(appealDecisionSchema) {}

// ---- blacklist -----------------------------------------------------------------

export const recommendBlacklistSchema = z
  .object({
    userId: uuid,
    reasonCode: z.enum(BLACKLIST_REASONS),
    severity: z.enum(BLACKLIST_SEVERITIES),
    summary: text,
    evidence: evidence.min(1),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type RecommendBlacklistInput = z.infer<typeof recommendBlacklistSchema>;
export class RecommendBlacklistDto extends createZodDto(recommendBlacklistSchema) {}

export const blacklistQuerySchema = z
  .object({ status: z.enum(BLACKLIST_STATUSES).optional(), ...paging })
  .strict();
export type BlacklistQuery = z.infer<typeof blacklistQuerySchema>;
export class BlacklistQueryDto extends createZodDto(blacklistQuerySchema) {}

export const blacklistDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(TEXT_INPUT_MAX).optional(),
  })
  .strict();
export type BlacklistDecisionInput = z.infer<typeof blacklistDecisionSchema>;
export class BlacklistDecisionDto extends createZodDto(blacklistDecisionSchema) {}

export const revokeBlacklistSchema = z.object({ reason: text }).strict();
export class RevokeBlacklistDto extends createZodDto(revokeBlacklistSchema) {}

// ---- complaints ----------------------------------------------------------------

export const submitComplaintSchema = z
  .object({
    subjectType: z.enum(['user', 'store']),
    /** A store's id, or a person's; for "the person on this post" send postId alone. */
    subjectId: uuid.optional(),
    category: z.enum(COMPLAINT_CATEGORIES),
    description: text,
    /** The post the person was seen on: it decides the area, and names the person if subjectId is absent. */
    postId: uuid.optional(),
    evidence: evidence.default([]),
  })
  .strict();
export type SubmitComplaintInput = z.infer<typeof submitComplaintSchema>;
export class SubmitComplaintDto extends createZodDto(submitComplaintSchema) {}

export const complaintQueueQuerySchema = z
  .object({
    status: z.enum(COMPLAINT_STATUSES).optional(),
    mine: z.enum(['true', 'false']).optional(),
    ...paging,
  })
  .strict();
export type ComplaintQueueQuery = z.infer<typeof complaintQueueQuerySchema>;
export class ComplaintQueueQueryDto extends createZodDto(complaintQueueQuerySchema) {}

export const updateComplaintSchema = z
  .object({
    /** Present: assign to this user (null: unassign). */
    assigneeUserId: uuid.nullable().optional(),
    priority: z.enum(COMPLAINT_PRIORITIES).optional(),
    status: z.enum(['pending', 'in_progress']).optional(),
  })
  .strict();
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;
export class UpdateComplaintDto extends createZodDto(updateComplaintSchema) {}

export const resolveComplaintSchema = z
  .object({ resolution: text, banId: uuid.optional() })
  .strict();
export type ResolveComplaintInput = z.infer<typeof resolveComplaintSchema>;
export class ResolveComplaintDto extends createZodDto(resolveComplaintSchema) {}

// ---- responses -----------------------------------------------------------------

const localized = z.object({ bn: z.string(), en: z.string().nullable() });

export const banNoticeSchema = z.object({
  /** area: a ban in one area; platform: the global blacklist. */
  kind: z.enum(['area', 'platform']),
  id: z.string(),
  reference: z.string(),
  severity: z.enum(['restricted', 'banned', 'terminated']),
  /** Why — a code the app shows in words; never the internal text. */
  reasonCode: z.string(),
  /** Which area (its name, never a person); null for the platform. */
  areaName: localized.nullable(),
  startsAt: z.string(),
  expiresAt: z.string().nullable(),
  permanent: z.boolean(),
  appeal: z
    .object({ id: z.string(), reference: z.string(), status: z.enum(APPEAL_STATUSES) })
    .nullable(),
  canAppeal: z.boolean(),
});
export type BanNotice = z.infer<typeof banNoticeSchema>;

export const banNoticesSchema = z.object({ items: z.array(banNoticeSchema) });
export type BanNotices = z.infer<typeof banNoticesSchema>;
export class BanNoticesDto extends createZodDto(banNoticesSchema) {}

export const accountAppealsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      status: z.enum(APPEAL_STATUSES),
      targetReference: z.string().nullable(),
      submittedAt: z.string(),
      decidedAt: z.string().nullable(),
    }),
  ),
});
export type AccountAppeals = z.infer<typeof accountAppealsSchema>;
export class AccountAppealsDto extends createZodDto(accountAppealsSchema) {}

export const appealSubmittedSchema = z.object({
  id: z.string(),
  reference: z.string(),
  status: z.enum(APPEAL_STATUSES),
});
export type AppealSubmitted = z.infer<typeof appealSubmittedSchema>;
export class AppealSubmittedDto extends createZodDto(appealSubmittedSchema) {}

/** The same answer whether or not the phone has a ban (no enumeration). */
export const appealOtpAcceptedSchema = z.object({
  status: z.literal('accepted'),
  /** The resend cooldown (otp_resend_cooldown_seconds) — the same for every phone. */
  resendAfterSeconds: z.number(),
});
export type AppealOtpAccepted = z.infer<typeof appealOtpAcceptedSchema>;
export class AppealOtpAcceptedDto extends createZodDto(appealOtpAcceptedSchema) {}

export const publicAppealStatusSchema = z.object({
  items: z.array(banNoticeSchema),
  appealsLeftToday: z.number(),
  /** Lets /appeals/submit follow without a second SMS (appeal_public_token_ttl_seconds). */
  appealToken: z.string(),
  appealTokenExpiresInSeconds: z.number(),
});
export type PublicAppealStatus = z.infer<typeof publicAppealStatusSchema>;
export class PublicAppealStatusDto extends createZodDto(publicAppealStatusSchema) {}

const banRowSchema = z.object({
  id: z.string(),
  reference: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  severity: z.enum(BAN_SEVERITIES),
  reasonCode: z.enum(BAN_REASONS),
  reasonText: z.string(),
  evidence: z.array(z.object({ type: z.string(), id: z.string() })),
  permanent: z.boolean(),
  startsAt: z.string(),
  expiresAt: z.string().nullable(),
  escalationStep: z.number(),
  status: z.enum(BAN_STATUSES),
  bannedByName: z.string().nullable(),
  revokeReason: z.string().nullable(),
  openAppeal: z.boolean(),
});
export const banListSchema = z.object({
  items: z.array(banRowSchema),
  nextAfter: z.string().nullable(),
});
export type BanList = z.infer<typeof banListSchema>;
export class BanListDto extends createZodDto(banListSchema) {}

export const issuedBanSchema = z.object({
  id: z.string(),
  reference: z.string(),
  startsAt: z.string(),
  expiresAt: z.string().nullable(),
  permanent: z.boolean(),
  escalationStep: z.number(),
});
export type IssuedBan = z.infer<typeof issuedBanSchema>;
export class IssuedBanDto extends createZodDto(issuedBanSchema) {}

export const liftedBanSchema = z.object({ status: z.literal('revoked') });
export class LiftedBanDto extends createZodDto(liftedBanSchema) {}

export const banMemberLookupSchema = z.object({
  items: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string().nullable(),
      role: z.string(),
      banSeverity: z.string().nullable(),
      priorBans: z.number(),
    }),
  ),
});
export type BanMemberLookup = z.infer<typeof banMemberLookupSchema>;
export class BanMemberLookupDto extends createZodDto(banMemberLookupSchema) {}

export const appealQueueItemSchema = z.object({
  id: z.string(),
  reference: z.string(),
  status: z.enum(APPEAL_STATUSES),
  queue: z.enum(['tenant_admin', 'platform']),
  channel: z.enum(['in_app', 'public_otp']),
  statement: z.string(),
  submittedAt: z.string(),
  escalateAt: z.string().nullable(),
  escalatedAt: z.string().nullable(),
  escalationReason: z.enum(['timeout', 'tenant_upheld']).nullable(),
  tenantRecommendation: z.literal('uphold').nullable(),
  tenantNote: z.string().nullable(),
  kind: z.enum(['area', 'platform']),
  targetId: z.string(),
  targetReference: z.string(),
  severity: z.string(),
  reasonCode: z.string(),
  reasonText: z.string(),
  evidence: z.array(z.object({ type: z.string(), id: z.string() })),
  permanent: z.boolean(),
  expiresAt: z.string().nullable(),
  areaName: z.string().nullable(),
  appellantUserId: z.string(),
  appellantName: z.string().nullable(),
});
export const appealQueueSchema = z.object({
  items: z.array(appealQueueItemSchema),
  nextAfter: z.string().nullable(),
});
export type AppealQueue = z.infer<typeof appealQueueSchema>;
export class AppealQueueDto extends createZodDto(appealQueueSchema) {}

export const appealDecisionResultSchema = z.object({
  status: z.enum(APPEAL_STATUSES),
  replacementReference: z.string().nullable(),
  replacementUntil: z.string().nullable(),
});
export type AppealDecisionResult = z.infer<typeof appealDecisionResultSchema>;
export class AppealDecisionResultDto extends createZodDto(appealDecisionResultSchema) {}

export const blacklistPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      userId: z.string().nullable(),
      displayName: z.string().nullable(),
      reasonCode: z.enum(BLACKLIST_REASONS),
      severity: z.enum(BLACKLIST_SEVERITIES),
      status: z.enum(BLACKLIST_STATUSES),
      summary: z.string(),
      evidence: z.array(z.object({ type: z.string(), id: z.string() })),
      expiresAt: z.string().nullable(),
      sourceAreaName: z.string().nullable(),
      recommendedByName: z.string().nullable(),
      createdAt: z.string(),
      reviewedAt: z.string().nullable(),
      reviewNote: z.string().nullable(),
    }),
  ),
  nextAfter: z.string().nullable(),
});
export type BlacklistPage = z.infer<typeof blacklistPageSchema>;
export class BlacklistPageDto extends createZodDto(blacklistPageSchema) {}

export const blacklistRecommendedSchema = z.object({ id: z.string(), reference: z.string() });
export class BlacklistRecommendedDto extends createZodDto(blacklistRecommendedSchema) {}

export const blacklistDecisionResultSchema = z.object({ status: z.enum(BLACKLIST_STATUSES) });
export class BlacklistDecisionResultDto extends createZodDto(blacklistDecisionResultSchema) {}

export const complaintSubmittedSchema = z.object({
  id: z.string(),
  reference: z.string(),
  status: z.enum(COMPLAINT_STATUSES),
  priority: z.enum(COMPLAINT_PRIORITIES),
  dueAt: z.string(),
});
export type ComplaintSubmitted = z.infer<typeof complaintSubmittedSchema>;
export class ComplaintSubmittedDto extends createZodDto(complaintSubmittedSchema) {}

export const myComplaintsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      subjectType: z.enum(['user', 'store']),
      subjectName: z.string().nullable(),
      category: z.enum(COMPLAINT_CATEGORIES),
      status: z.enum(COMPLAINT_STATUSES),
      createdAt: z.string(),
      resolvedAt: z.string().nullable(),
    }),
  ),
});
export type MyComplaints = z.infer<typeof myComplaintsSchema>;
export class MyComplaintsDto extends createZodDto(myComplaintsSchema) {}

export const complaintQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      subjectType: z.enum(['user', 'store']),
      subjectId: z.string(),
      /** The person to ban, if it comes to that (a store's owner). */
      subjectUserId: z.string(),
      subjectName: z.string().nullable(),
      subjectBanSeverity: z.string().nullable(),
      reporterName: z.string().nullable(),
      category: z.enum(COMPLAINT_CATEGORIES),
      priority: z.enum(COMPLAINT_PRIORITIES),
      status: z.enum(COMPLAINT_STATUSES),
      description: z.string(),
      evidence: z.array(z.object({ type: z.string(), id: z.string() })),
      assignedToUserId: z.string().nullable(),
      assignedToName: z.string().nullable(),
      dueAt: z.string(),
      overdue: z.boolean(),
      createdAt: z.string(),
      resolution: z.string().nullable(),
      resolvedAt: z.string().nullable(),
      banId: z.string().nullable(),
    }),
  ),
  nextAfter: z.string().nullable(),
});
export type ComplaintQueue = z.infer<typeof complaintQueueSchema>;
export class ComplaintQueueDto extends createZodDto(complaintQueueSchema) {}

export const complaintAssigneesSchema = z.object({
  items: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string().nullable(),
      role: z.string(),
      openCount: z.number(),
    }),
  ),
});
export type ComplaintAssignees = z.infer<typeof complaintAssigneesSchema>;
export class ComplaintAssigneesDto extends createZodDto(complaintAssigneesSchema) {}

export const complaintUpdatedSchema = z.object({
  reference: z.string(),
  status: z.enum(COMPLAINT_STATUSES),
  priority: z.enum(COMPLAINT_PRIORITIES),
  assignedToUserId: z.string().nullable(),
  dueAt: z.string(),
});
export type ComplaintUpdated = z.infer<typeof complaintUpdatedSchema>;
export class ComplaintUpdatedDto extends createZodDto(complaintUpdatedSchema) {}

export const complaintResolvedSchema = z.object({ status: z.literal('resolved') });
export class ComplaintResolvedDto extends createZodDto(complaintResolvedSchema) {}

import type { components } from '@amar-elaka/shared-types';
import { z } from 'zod';

/**
 * Runtime checks for the API responses this app reads. The types come from the
 * zod schemas, and the assertions at the bottom tie each one to the API's
 * published OpenAPI type — so a shape change in the API, once `pnpm gen:api`
 * regenerates the types, fails this app's typecheck instead of failing at
 * runtime. A schema may read fewer fields than the API sends; it may not read
 * one the API does not send, or read it as the wrong type.
 */

export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type SessionTokens = z.infer<typeof sessionTokensSchema>;

export const tenantSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  districtNameBn: z.string().nullable(),
  districtNameEn: z.string().nullable(),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

/** Matches PermissionsService's EffectivePermissions plus MeController's `role`. */
export const grantSchema = z.object({ module: z.string(), action: z.string() });
export type Grant = z.infer<typeof grantSchema>;

export const effectivePermissionsSchema = z.object({
  isPlatformAdmin: z.boolean(),
  grants: z.array(grantSchema),
  role: z.string().optional(),
});
export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;

/** Matches AuthService's MeResult. */
export const meSchema = z.object({
  userId: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  avatarStorageKey: z.string().nullable(),
  tenantId: z.string(),
  memberId: z.string(),
  role: z.string(),
});
export type Me = z.infer<typeof meSchema>;

/** Matches RolesRepository's RoleWithPermissions. */
export const roleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  isBuiltin: z.boolean(),
  permissions: z.array(grantSchema),
});
export type Role = z.infer<typeof roleSchema>;

/** Matches HeatmapDto (apps/api/src/analytics/dto/analytics.dto.ts, ADR 050). */
export const heatmapSchema = z.object({
  type: z.enum(['demand', 'supply']),
  category: z.string().nullable(),
  precision: z.number(),
  minCellCount: z.number(),
  windowDays: z.number(),
  cells: z.array(
    z.object({ geohash: z.string(), lat: z.number(), lng: z.number(), count: z.number() }),
  ),
});
export type Heatmap = z.infer<typeof heatmapSchema>;

/** The parts of MapConfigDto (GET /map/config, ADR 043) the heatmap page draws its base map with. */
export const mapConfigSchema = z.object({
  tiles: z
    .object({
      url: z.string(),
      version: z.string(),
      maxZoom: z.number(),
      bounds: z.array(z.number()),
    })
    .nullable(),
  assetsBaseUrl: z.string(),
  labelLanguage: z.enum(['bn', 'en']),
});
export type MapConfig = z.infer<typeof mapConfigSchema>;

/** The parts of CatalogCategoryDto the heatmap's category filter lists. */
export const catalogCategorySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  slug: z.string(),
  kind: z.enum(['marketplace', 'service', 'job', 'rental', 'place', 'module']),
  name: z.object({ bn: z.string(), en: z.string() }),
});
export type CatalogCategory = z.infer<typeof catalogCategorySchema>;

// ---- the Places tab of the moderation queue (ADR 047, 048, 051) -------------

const latLng = z.object({ lat: z.number(), lng: z.number() });
const hoursRange = z.object({ day: z.number(), opens: z.string(), closes: z.string() });
const suggestionChanges = z.object({
  location: latLng.optional(),
  phones: z.array(z.string()).optional(),
  hours: z.array(hoursRange).optional(),
});
export type SuggestionChanges = z.infer<typeof suggestionChanges>;

/** Matches ReviewQueueDto (GET /places/review-queue). */
export const placeReviewQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      nameBn: z.string(),
      nameEn: z.string().nullable(),
      categoryId: z.string(),
      location: latLng,
      outsideBoundary: z.boolean(),
      photoCount: z.number(),
      createdByUserId: z.string().nullable(),
      queuedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type PlaceReviewItem = z.infer<typeof placeReviewQueueSchema>['items'][number];

/** Matches ClaimQueueDto (GET /place-claims/queue). */
export const placeClaimQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      place: z.object({ id: z.string(), nameBn: z.string(), phones: z.array(z.string()) }),
      claimantMemberId: z.string(),
      claimantUserId: z.string().nullable(),
      evidence: z.array(z.string()),
      otpVerifiedPhone: z.string().nullable(),
      documentIds: z.array(z.string()),
      note: z.string().nullable(),
      competingClaims: z.number(),
      queuedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type PlaceClaimItem = z.infer<typeof placeClaimQueueSchema>['items'][number];

/** Matches DuplicatePageDto (GET /places/duplicates). */
export const duplicatePageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      entityType: z.enum(['place', 'store']),
      entity: z.object({ id: z.string(), nameBn: z.string().nullable() }),
      candidate: z.object({ id: z.string(), tenantId: z.string(), nameBn: z.string().nullable() }),
      score: z.number(),
      classification: z.enum(['likely', 'possible']),
      signals: z.record(z.unknown()),
      source: z.enum(['create', 'batch', 'report']),
      status: z.enum(['open', 'merged', 'dismissed']),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type DuplicateItem = z.infer<typeof duplicatePageSchema>['items'][number];

/** Matches PlaceReportQueueDto (GET /place-reports/queue). */
export const placeReportQueueSchema = z.object({
  items: z.array(
    z.object({
      placeId: z.string(),
      nameBn: z.string(),
      nameEn: z.string().nullable(),
      status: z.string(),
      location: latLng,
      possiblyClosed: z.boolean(),
      reasons: z.record(z.number()),
      reporterCount: z.number(),
      notes: z.array(z.string()),
      firstReportedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type PlaceReportItem = z.infer<typeof placeReportQueueSchema>['items'][number];

/** Matches SuggestionQueueDto (GET /place-suggestions/queue). */
export const placeSuggestionQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      placeId: z.string(),
      placeNameBn: z.string(),
      placeNameEn: z.string().nullable(),
      changes: suggestionChanges,
      current: suggestionChanges,
      note: z.string().nullable(),
      suggesterMemberId: z.string(),
      suggesterTrustScore: z.number(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type PlaceSuggestionItem = z.infer<typeof placeSuggestionQueueSchema>['items'][number];

/**
 * The decision endpoints' answers differ (a dismissal is 204, no body); the
 * page only needs "it worked" and reloads.
 */
export const placeActionResultSchema = z.object({}).passthrough().nullable();

type Api = components['schemas'];
/** True when every value the API may send is one this app's schema accepts. */
type Accepts<Local, Published> = [Published] extends [Local] ? true : false;
type Assert<T extends true> = T;

export type _ApiContract = [
  Assert<Accepts<SessionTokens, Api['SessionTokensDto']>>,
  Assert<Accepts<TenantSummary, Api['TenantSummaryDto']>>,
  Assert<Accepts<EffectivePermissions, Api['MyPermissionsDto']>>,
  Assert<Accepts<Me, Api['MeResultDto']>>,
  Assert<Accepts<Role, Api['RoleDto']>>,
  Assert<Accepts<Heatmap, Api['HeatmapDto']>>,
  Assert<Accepts<MapConfig, Api['MapConfigDto']>>,
  Assert<Accepts<CatalogCategory, Api['CatalogCategoryDto']>>,
  Assert<Accepts<z.infer<typeof placeReviewQueueSchema>, Api['ReviewQueueDto']>>,
  Assert<Accepts<z.infer<typeof placeClaimQueueSchema>, Api['ClaimQueueDto']>>,
  Assert<Accepts<z.infer<typeof duplicatePageSchema>, Api['DuplicatePageDto']>>,
  Assert<Accepts<z.infer<typeof placeReportQueueSchema>, Api['PlaceReportQueueDto']>>,
  Assert<Accepts<z.infer<typeof placeSuggestionQueueSchema>, Api['SuggestionQueueDto']>>,
];

/** Matches QueuePageDto (apps/api/src/moderation/dto/moderation.dto.ts). */
export const moderationQueueItemSchema = z.object({
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
export type ModerationQueueItem = z.infer<typeof moderationQueueItemSchema>;

export const moderationQueuePageSchema = z.object({
  items: z.array(moderationQueueItemSchema),
  nextCursor: z.string().nullable(),
});

/** Matches ModerationResultDto. */
export const moderationResultSchema = z.object({
  postId: z.string(),
  status: z.string(),
  scrubbed: z.boolean(),
});

// ---- verification (ADR 062) -------------------------------------------------

const verificationStatus = z.enum([
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'expired',
  'revoked',
]);
const verificationLevel = z.enum(['identity_checked', 'business_verified']);
export const verificationQueueItemSchema = z.object({
  id: z.string(),
  subjectType: z.enum(['member', 'store']),
  subjectId: z.string(),
  subjectName: z.string().nullable(),
  level: verificationLevel,
  status: verificationStatus,
  nidLast3: z.string().nullable(),
  nidDuplicate: z.boolean(),
  visitStatus: z.enum(['not_needed', 'requested', 'done']),
  evidenceCount: z.number(),
  createdAt: z.string(),
});
export type VerificationQueueItem = z.infer<typeof verificationQueueItemSchema>;
export const verificationQueueSchema = z.object({
  items: z.array(verificationQueueItemSchema),
  nextAfter: z.string().nullable(),
});
export const verificationDetailSchema = verificationQueueItemSchema.extend({
  note: z.string().nullable(),
  rejectionReason: z
    .enum([
      'document_unclear',
      'document_expired',
      'name_mismatch',
      'suspected_fraud',
      'duplicate_submission',
      'other',
    ])
    .nullable(),
  expiresAt: z.string().nullable(),
  documentsPurged: z.boolean(),
  ownerLevel: z
    .enum(['none', 'phone_verified', 'identity_checked', 'business_verified'])
    .nullable(),
  urlExpiresInSeconds: z.number(),
  evidence: z.array(
    z.object({
      kind: z.enum(['selfie', 'trade_licence', 'shop_front', 'visit_photo']),
      mimeType: z.string().nullable(),
      url: z.string().nullable(),
      previewUrl: z.string().nullable(),
      purged: z.boolean(),
    }),
  ),
  history: z.array(
    z.object({
      id: z.string(),
      status: verificationStatus,
      createdAt: z.string(),
      reviewedAt: z.string().nullable(),
      rejectionReason: z.string().nullable(),
    }),
  ),
});
export type VerificationDetail = z.infer<typeof verificationDetailSchema>;
export const verificationDecisionResultSchema = z.object({
  status: verificationStatus,
  expiresAt: z.string().nullable(),
});

export type _VerificationContract = [
  Assert<Accepts<z.infer<typeof verificationQueueSchema>, Api['VerificationQueueDto']>>,
  Assert<Accepts<VerificationDetail, Api['VerificationDetailDto']>>,
  Assert<
    Accepts<z.infer<typeof verificationDecisionResultSchema>, Api['VerificationDecisionResultDto']>
  >,
];

// ---- Bans, appeals, blacklist, complaints (ADR 063; apps/api/src/bans/dto/bans.dto.ts) ----

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
export const COMPLAINT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
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
const appealStatus = z.enum([
  'submitted',
  'in_review',
  'escalated',
  'upheld',
  'granted',
  'reduced',
  'withdrawn',
]);
const evidenceRefs = z.array(z.object({ type: z.string(), id: z.string() }));

export const banListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      userId: z.string(),
      displayName: z.string().nullable(),
      severity: z.enum(['restricted', 'banned']),
      reasonCode: z.enum(BAN_REASONS),
      reasonText: z.string(),
      evidence: evidenceRefs,
      permanent: z.boolean(),
      startsAt: z.string(),
      expiresAt: z.string().nullable(),
      escalationStep: z.number(),
      status: z.enum(['active', 'expired', 'revoked', 'superseded']),
      bannedByName: z.string().nullable(),
      revokeReason: z.string().nullable(),
      openAppeal: z.boolean(),
    }),
  ),
  nextAfter: z.string().nullable(),
});
export type BanListItem = z.infer<typeof banListSchema>['items'][number];

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
export type BanMember = z.infer<typeof banMemberLookupSchema>['items'][number];

export const issuedBanSchema = z.object({
  id: z.string(),
  reference: z.string(),
  startsAt: z.string(),
  expiresAt: z.string().nullable(),
  permanent: z.boolean(),
  escalationStep: z.number(),
});

export const appealQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      status: appealStatus,
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
      evidence: evidenceRefs,
      permanent: z.boolean(),
      expiresAt: z.string().nullable(),
      areaName: z.string().nullable(),
      appellantUserId: z.string(),
      appellantName: z.string().nullable(),
    }),
  ),
  nextAfter: z.string().nullable(),
});
export type AppealQueueItem = z.infer<typeof appealQueueSchema>['items'][number];
export const appealDecisionResultSchema = z.object({
  status: appealStatus,
  replacementReference: z.string().nullable(),
  replacementUntil: z.string().nullable(),
});

export const blacklistPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      userId: z.string().nullable(),
      displayName: z.string().nullable(),
      reasonCode: z.enum(BLACKLIST_REASONS),
      severity: z.enum(BLACKLIST_SEVERITIES),
      status: z.enum(['recommended', 'active', 'rejected', 'revoked', 'expired']),
      summary: z.string(),
      evidence: evidenceRefs,
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
export type BlacklistItem = z.infer<typeof blacklistPageSchema>['items'][number];
export const blacklistRecommendedSchema = z.object({ id: z.string(), reference: z.string() });
export const blacklistDecisionResultSchema = z.object({
  status: z.enum(['recommended', 'active', 'rejected', 'revoked', 'expired']),
});
export const revokedSchema = z.object({ status: z.literal('revoked') });

export const complaintQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      subjectType: z.enum(['user', 'store']),
      subjectId: z.string(),
      subjectUserId: z.string(),
      subjectName: z.string().nullable(),
      subjectBanSeverity: z.string().nullable(),
      reporterName: z.string().nullable(),
      category: z.enum(['fake_seller', 'scam', 'abuse', 'other']),
      priority: z.enum(COMPLAINT_PRIORITIES),
      status: z.enum(['pending', 'in_progress', 'resolved']),
      description: z.string(),
      evidence: evidenceRefs,
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
export type ComplaintItem = z.infer<typeof complaintQueueSchema>['items'][number];
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
export type ComplaintAssignee = z.infer<typeof complaintAssigneesSchema>['items'][number];
export const complaintUpdatedSchema = z.object({
  reference: z.string(),
  status: z.enum(['pending', 'in_progress', 'resolved']),
  priority: z.enum(COMPLAINT_PRIORITIES),
  assignedToUserId: z.string().nullable(),
  dueAt: z.string(),
});
export const complaintResolvedSchema = z.object({ status: z.literal('resolved') });

export type _BansContract = [
  Assert<Accepts<z.infer<typeof banListSchema>, Api['BanListDto']>>,
  Assert<Accepts<z.infer<typeof banMemberLookupSchema>, Api['BanMemberLookupDto']>>,
  Assert<Accepts<z.infer<typeof issuedBanSchema>, Api['IssuedBanDto']>>,
  Assert<Accepts<z.infer<typeof appealQueueSchema>, Api['AppealQueueDto']>>,
  Assert<Accepts<z.infer<typeof appealDecisionResultSchema>, Api['AppealDecisionResultDto']>>,
  Assert<Accepts<z.infer<typeof blacklistPageSchema>, Api['BlacklistPageDto']>>,
  Assert<Accepts<z.infer<typeof blacklistRecommendedSchema>, Api['BlacklistRecommendedDto']>>,
  Assert<Accepts<z.infer<typeof blacklistDecisionResultSchema>, Api['BlacklistDecisionResultDto']>>,
  Assert<Accepts<z.infer<typeof revokedSchema>, Api['LiftedBanDto']>>,
  Assert<Accepts<z.infer<typeof complaintQueueSchema>, Api['ComplaintQueueDto']>>,
  Assert<Accepts<z.infer<typeof complaintAssigneesSchema>, Api['ComplaintAssigneesDto']>>,
  Assert<Accepts<z.infer<typeof complaintUpdatedSchema>, Api['ComplaintUpdatedDto']>>,
  Assert<Accepts<z.infer<typeof complaintResolvedSchema>, Api['ComplaintResolvedDto']>>,
];

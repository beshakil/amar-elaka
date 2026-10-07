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

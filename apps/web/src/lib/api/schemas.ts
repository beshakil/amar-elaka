import type { components } from '@amar-elaka/shared-types';
import { z } from 'zod';

/**
 * Runtime checks for the API responses this app reads. The types come from the
 * zod schemas, and the assertions at the bottom tie each one to the API's
 * published OpenAPI type — so a shape change in the API, once `pnpm gen:api`
 * regenerates the types, fails this app's typecheck instead of failing at
 * runtime.
 */

export const tenantSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  mapCenter: z.object({ lat: z.number(), lng: z.number() }),
  districtNameBn: z.string().nullable(),
  districtNameEn: z.string().nullable(),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

export const tenantConfigSchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  defaultLocale: z.string(),
  mapCenter: z.object({ lat: z.number(), lng: z.number() }),
  radiusKm: z.number().nullable(),
  branding: z.object({ logoStorageKey: z.string().nullable() }),
  featureFlags: z.record(z.unknown()),
  enabledCategories: z.array(
    z.object({
      slug: z.string(),
      nameBn: z.string(),
      nameEn: z.string(),
      iconKey: z.string().nullable(),
    }),
  ),
  emergencyNumbers: z.array(
    z.object({
      serviceType: z.string(),
      nameBn: z.string(),
      nameEn: z.string().nullable(),
      phones: z.array(z.string()),
      is24h: z.boolean(),
    }),
  ),
  support: z.object({
    phoneE164: z.string().nullable(),
    email: z.string().nullable(),
    whatsappE164: z.string().nullable(),
  }),
  /** Optional: a cached/older API may not send it (then 12 h, the seeded default). */
  moderation: z.object({ typicalReviewHours: z.number() }).optional(),
});
export type TenantConfig = z.infer<typeof tenantConfigSchema>;

type Api = components['schemas'];
/** True when every value the API may send is one this app's schema accepts. */
type Accepts<Local, Published> = [Published] extends [Local] ? true : false;
type Assert<T extends true> = T;

export type _ApiContract = [
  Assert<Accepts<TenantSummary, Api['TenantSummaryDto']>>,
  Assert<Accepts<TenantConfig, Api['TenantConfigDto']>>,
];

// ---- auth -------------------------------------------------------------------

export const sessionTokensSchema = z.object({ accessToken: z.string(), refreshToken: z.string() });
export const otpSentSchema = z.object({
  status: z.literal('otp_sent'),
  resendAfterSeconds: z.number(),
});
export type OtpSent = z.infer<typeof otpSentSchema>;

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

// ---- categories, geocoding ----------------------------------------------------

export const catalogCategorySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  slug: z.string(),
  kind: z.string(),
  name: z.object({ bn: z.string(), en: z.string() }),
  iconKey: z.string().nullable(),
  requiresApproval: z.boolean(),
  /** Null for module tiles: nothing to post there. */
  fieldSchema: z
    .object({
      jsonSchema: z.record(z.unknown()),
      uiSchema: z.record(z.unknown()),
      filterableFields: z.array(z.string()),
      searchableFields: z.array(z.string()),
    })
    .nullable(),
});
export type CatalogCategory = z.infer<typeof catalogCategorySchema>;

const point = z.object({ lat: z.number(), lng: z.number() });
export const geocodeResultSchema = z.object({
  label: z.string(),
  labelBn: z.string().nullable(),
  location: point,
  area: z.string().nullable(),
  city: z.string().nullable(),
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;
export const geocodeResponseSchema = z.object({
  results: z.array(geocodeResultSchema),
  degraded: z.boolean(),
});
export const reverseGeocodeSchema = z.object({
  address: geocodeResultSchema.nullable(),
  areas: z.array(
    z.object({ level: z.string(), name: z.object({ bn: z.string().nullable(), en: z.string() }) }),
  ),
  degraded: z.boolean(),
});
export type ReverseGeocode = z.infer<typeof reverseGeocodeSchema>;

// ---- media --------------------------------------------------------------------

export const presignedMediaSchema = z.object({
  id: z.string(),
  upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string()) }),
});
export const mediaStatusSchema = z.object({
  id: z.string(),
  status: z.enum(['pending_upload', 'processing', 'ready', 'rejected', 'quarantined']),
});

// ---- posts --------------------------------------------------------------------

export const POST_STATUSES = [
  'draft',
  'pending',
  'live',
  'rejected',
  'sold',
  'expired',
  'removed',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const postSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(POST_STATUSES),
  categoryId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  fields: z.record(z.unknown()),
  price: z.string().nullable(),
  location: point.nullable(),
  media: z.array(
    z.object({
      id: z.string(),
      thumbUrl: z.string().nullable(),
      cardUrl: z.string().nullable(),
      fullUrl: z.string().nullable(),
    }),
  ),
  showPhone: z.boolean(),
  allowChat: z.boolean(),
  showWhatsapp: z.boolean(),
  contact: z.object({
    name: z.string().nullable(),
    phone: z.string().nullable(),
    whatsapp: z.boolean(),
  }),
  isSold: z.boolean(),
  soldPrice: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  hiddenByOwner: z.boolean().optional(),
  moderationReason: z.string().nullable().optional(),
  moderationNote: z.string().nullable().optional(),
});
export type Post = z.infer<typeof postSchema>;

export const myPostsSchema = z.object({
  items: z.array(postSchema),
  nextCursor: z.string().nullable(),
});
export type MyPostsPage = z.infer<typeof myPostsSchema>;

export const myPostCountsSchema = z.object({
  draft: z.number(),
  pending: z.number(),
  live: z.number(),
  rejected: z.number(),
  sold: z.number(),
  expired: z.number(),
  removed: z.number(),
  hidden: z.number(),
});
export type MyPostCounts = z.infer<typeof myPostCountsSchema>;

export const ownershipSchema = z.object({
  tenantId: z.string(),
  resolution: z.string(),
  outsideBoundary: z.boolean(),
  needsReview: z.boolean(),
});
export type Ownership = z.infer<typeof ownershipSchema>;

export type _PostContract = [
  Assert<Accepts<z.infer<typeof sessionTokensSchema>, Api['SessionTokensDto']>>,
  Assert<Accepts<Me, Api['MeResultDto']>>,
  Assert<Accepts<Post, Api['PostDto']>>,
  Assert<Accepts<MyPostsPage, Api['MyPostsDto']>>,
  Assert<Accepts<MyPostCounts, Api['MyPostCountsDto']>>,
  Assert<Accepts<Ownership, Api['OwnershipDto']>>,
];

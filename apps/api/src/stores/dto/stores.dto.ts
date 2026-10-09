import { STORE_CONTACT_CHANNELS } from '../../engagement/store-channels';
import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { postCardSchema } from '../../feed/dto/feed.dto';
import { hoursViewSchema, weeklyHoursSchema } from '../../hours/dto/hours.dto';
import { STORE_TIERS } from '../store-limits';
import { STORE_SLUG_PATTERN } from '../store-slug';

// settings-exempt: WGS84 latitude/longitude bounds, a validation range.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;

export const STORE_STATUSES = ['pending_review', 'active', 'suspended', 'closed'] as const;
export const STORE_ROLES = ['owner', 'manager', 'editor'] as const;
export const STAFF_ROLES = ['manager', 'editor'] as const;
/** What moderation may set (POST /stores/:id/status); pending_review is only where a store starts. */
export const MODERATED_STATUSES = ['active', 'suspended', 'closed'] as const;
export const VERIFICATION_BADGES = ['none', 'phone', 'identity', 'business'] as const;

const name = z.string().trim().min(1);
const text = z.string().trim().min(1);
/** Any Bangladeshi mobile spelling (01712345678, +880 1712-345678); normalised by the service. */
const phone = z.string().trim().min(1);
const location = z
  .object({
    lat: z.number().min(-MAX_LAT).max(MAX_LAT),
    lng: z.number().min(-MAX_LNG).max(MAX_LNG),
  })
  .strict();
const slug = z.string().trim().toLowerCase();
const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });
const image = z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable();
const point = z.object({ lat: z.number(), lng: z.number() });

// ---- requests --------------------------------------------------------------

export const createStoreSchema = z
  .object({
    nameBn: name,
    nameEn: name.optional(),
    /** Optional: generated from the name (Latin letters) when left out. */
    slug: slug.optional(),
    description: text.optional(),
    /** A place category enabled in the store's area: what the store sells or does. */
    categoryId: z.string().uuid(),
    /** Ready images from POST /media/presign + confirm, uploaded in the store's area. */
    logoMediaId: z.string().uuid().optional(),
    bannerMediaId: z.string().uuid().optional(),
    phone: phone.optional(),
    whatsapp: phone.optional(),
    addressText: text.optional(),
    /** Decides the store's area (the same rule as posts) and is its map pin. */
    location,
    /** The weekly schedule (GET/PUT /stores/:id/hours afterwards). */
    hours: weeklyHoursSchema.optional(),
    /** A likely duplicate place nearby holds the creation until the owner says it isn't theirs. */
    confirmNotDuplicate: z.boolean().default(false),
  })
  .strict();
export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export class CreateStoreDto extends createZodDto(createStoreSchema) {}

export const updateStoreSchema = z
  .object({
    nameBn: name,
    nameEn: name.nullable(),
    /** The owner may change it once; the old one keeps working as a redirect. */
    slug,
    description: text.nullable(),
    categoryId: z.string().uuid(),
    logoMediaId: z.string().uuid().nullable(),
    bannerMediaId: z.string().uuid().nullable(),
    phone: phone.nullable(),
    whatsapp: phone.nullable(),
    addressText: text.nullable(),
    /** Within the store's area: a store can't move to another thana. */
    location,
    hours: weeklyHoursSchema,
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.');
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
export class UpdateStoreDto extends createZodDto(updateStoreSchema) {}

export const inviteStaffSchema = z
  .object({
    phone,
    role: z.enum(STAFF_ROLES),
  })
  .strict();
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
export class InviteStaffDto extends createZodDto(inviteStaffSchema) {}

export const storeStatusSchema = z
  .object({
    status: z.enum(MODERATED_STATUSES),
    /** A moderation_reasons code: spam, scam_suspected, policy_violation, meets_guidelines, owner_request… */
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]*$/),
    reasonText: text.optional(),
  })
  .strict();
export type StoreStatusInput = z.infer<typeof storeStatusSchema>;
export class StoreStatusDto extends createZodDto(storeStatusSchema) {}

export const storeIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class StoreIdParamDto extends createZodDto(storeIdParamSchema) {}

export const staffParamSchema = z
  .object({ id: z.string().uuid(), memberId: z.string().uuid() })
  .strict();
export class StaffParamDto extends createZodDto(staffParamSchema) {}

/** A store slug in a path. */
export const STORE_SLUG_PATTERN_DTO = z.string().regex(STORE_SLUG_PATTERN);
export const storeSlugParamSchema = z
  .object({ slug: z.string().regex(STORE_SLUG_PATTERN) })
  .strict();
export class StoreSlugParamDto extends createZodDto(storeSlugParamSchema) {}

export const storePageQuerySchema = z
  .object({
    /** Only the catalog's posts in this category (or its subcategories). */
    category: z.string().regex(STORE_SLUG_PATTERN).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export type StorePageQuery = z.infer<typeof storePageQuerySchema>;
export class StorePageQueryDto extends createZodDto(storePageQuerySchema) {}

export const storeReviewQueueQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export type StoreReviewQueueQuery = z.infer<typeof storeReviewQueueQuerySchema>;
export class StoreReviewQueueQueryDto extends createZodDto(storeReviewQueueQuerySchema) {}

// ---- responses -------------------------------------------------------------

const categoryRef = z.object({ id: z.string(), slug: z.string(), name: localized }).nullable();

export const staffViewSchema = z.object({
  memberId: z.string(),
  displayName: z.string().nullable(),
  /** Enough to recognise the number, not to harvest it (+8801••••••678). */
  phoneMasked: z.string().nullable(),
  role: z.enum(STAFF_ROLES),
  accepted: z.boolean(),
  invitedAt: z.string(),
  acceptedAt: z.string().nullable(),
});
export type StaffView = z.infer<typeof staffViewSchema>;
export class StaffViewDto extends createZodDto(staffViewSchema) {}

/** A store as its owner and staff see it. Only they get its numbers here. */
export const storeViewSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  previousSlug: z.string().nullable(),
  /** The owner hasn't used their one slug change yet. */
  slugChangeable: z.boolean(),
  /** The WhatsApp catalog on the tenant's site: what the counter card's QR code opens (ADR 057). */
  catalogUrl: z.string(),
  name: localized,
  description: z.string().nullable(),
  category: categoryRef,
  logo: image,
  banner: image,
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  addressText: z.string().nullable(),
  location: point.nullable(),
  placeId: z.string().nullable(),
  status: z.enum(STORE_STATUSES),
  tier: z.enum(STORE_TIERS),
  isVerified: z.boolean(),
  /** From settings for the store's tier. */
  limits: z.object({ staff: z.number(), catalog: z.number() }),
  counts: z.object({ staff: z.number(), catalog: z.number() }),
  myRole: z.enum(STORE_ROLES),
  /** Managers and the owner see the staff; editors get an empty list. */
  staff: z.array(staffViewSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoreView = z.infer<typeof storeViewSchema>;
export class StoreViewDto extends createZodDto(storeViewSchema) {}

export const myStoresSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      tenantId: z.string(),
      slug: z.string(),
      name: localized,
      status: z.enum(STORE_STATUSES),
      tier: z.enum(STORE_TIERS),
      logo: image,
      role: z.enum(STORE_ROLES),
      /** false: an invitation waiting for POST /stores/:id/staff/accept. */
      accepted: z.boolean(),
      invitedAt: z.string().nullable(),
    }),
  ),
});
export type MyStores = z.infer<typeof myStoresSchema>;
export class MyStoresDto extends createZodDto(myStoresSchema) {}

/**
 * GET /stores/:slug: a store's public page (ADR 039, extended by ADR 054).
 * Never its phone numbers: calling goes through POST /stores/:id/contact,
 * which records the lead. `slug` is the current one; when it differs from
 * the requested (an old link), the client redirects.
 */
export const storePageSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  /** The page on the tenant's site, for sharing (ADR 057). */
  url: z.string(),
  /** The signed-in viewer follows it; false for a guest. */
  isFollowing: z.boolean(),
  /** Which POST /stores/:id/contact channels it takes — never the numbers. */
  contactChannels: z.array(z.enum(STORE_CONTACT_CHANNELS)),
  name: localized,
  description: z.string().nullable(),
  category: categoryRef,
  addressText: z.string().nullable(),
  area: localized.nullable(),
  location: point.nullable(),
  /** The store's pin on the map: its place. */
  mapPin: z.object({ lat: z.number(), lng: z.number(), placeId: z.string().nullable() }).nullable(),
  logo: image,
  cover: image,
  isVerified: z.boolean(),
  verification: z.object({
    /** The badge to show: business = verified store; else the owner's seller verification. */
    badge: z.enum(VERIFICATION_BADGES),
    storeVerified: z.boolean(),
  }),
  rating: z.number().nullable(),
  ratingCount: z.number(),
  followerCount: z.number(),
  stats: z.object({
    followers: z.number(),
    livePosts: z.number(),
    memberSince: z.string(),
  }),
  hours: hoursViewSchema,
  /** Categories in the catalog, for the filter chips. */
  catalogCategories: z.array(z.object({ slug: z.string(), name: localized, count: z.number() })),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The catalog: live posts, newest first (filtered by `category`). */
  posts: z.array(postCardSchema),
  nextCursor: z.string().nullable(),
});
export type StorePage = z.infer<typeof storePageSchema>;
export class StorePageDto extends createZodDto(storePageSchema) {}

export const storeStatusResultSchema = z.object({
  storeId: z.string(),
  status: z.enum(STORE_STATUSES),
});
export type StoreStatusResult = z.infer<typeof storeStatusResultSchema>;
export class StoreStatusResultDto extends createZodDto(storeStatusResultSchema) {}

export const storeReviewQueueSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: localized,
      category: categoryRef,
      location: point.nullable(),
      ownerMemberId: z.string(),
      outsideBoundary: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type StoreReviewQueue = z.infer<typeof storeReviewQueueSchema>;
export class StoreReviewQueueDto extends createZodDto(storeReviewQueueSchema) {}

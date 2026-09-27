import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { filtersParam } from '../../search/dto/search.dto';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: generic input-length cap on an opaque token, not a business threshold.
const CURSOR_MAX_CHARS = 1_000;

export const FEED_SCOPES = ['area', 'nearby', 'country'] as const;
export type FeedScope = (typeof FEED_SCOPES)[number];

const coordinate = (max: number) => z.coerce.number().min(-max).max(max);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * GET /feed. Discovery is a radius around the viewer (schema.md §13.26):
 *   area    — feed_default_radius_km (tenant setting); radius_km is ignored.
 *   nearby  — radius_km, capped at feed_max_radius_km.
 *   country — shippable categories only, no radius.
 * Without lat/lng the tenant's map centre stands in for the viewer.
 * `filters` is the same JSON as /search (needs `category`).
 */
export const feedQuerySchema = z
  .object({
    lat: coordinate(MAX_LAT).optional(),
    lng: coordinate(MAX_LNG).optional(),
    scope: z.enum(FEED_SCOPES).default('area'),
    radius_km: z.coerce.number().positive().optional(),
    category: slug.optional(),
    filters: filtersParam.optional(),
    cursor: z
      .string()
      .max(CURSOR_MAX_CHARS)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    /** Post cards per page; defaults to feed_page_size_default, capped at feed_page_size_max. */
    limit: z.coerce.number().int().min(1).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng go together',
    path: ['lat'],
  })
  .refine((v) => v.filters === undefined || v.category !== undefined, {
    message: 'filters need a category',
    path: ['filters'],
  });
export class FeedQueryDto extends createZodDto(feedQuerySchema) {}
export type FeedQuery = z.infer<typeof feedQuerySchema>;

// ---- responses ----------------------------------------------------------

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });
const cover = z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable();

/** Badge codes; clients translate them. */
export const POST_BADGES = [
  'boosted',
  'highlighted',
  'verified_store',
  'free',
  'negotiable',
] as const;

export const postCardSchema = z.object({
  kind: z.literal('post'),
  id: z.string(),
  /** Owning tenant: where the post detail is read. */
  tenantId: z.string(),
  title: z.string(),
  /** Money as a string with two decimals, never a float. */
  price: z.string().nullable(),
  cover,
  /** Metres from the feed origin; null for a post with no location (country scope). */
  distanceMeters: z.number().nullable(),
  area: localized.nullable(),
  badges: z.array(z.enum(POST_BADGES)),
  createdAt: z.string(),
});

export const storeCardSchema = z.object({
  kind: z.literal('store'),
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  name: localized,
  cover,
  distanceMeters: z.number(),
  isVerified: z.boolean(),
  rating: z.number().nullable(),
});

export const landmarkCardSchema = z.object({
  kind: z.literal('landmark'),
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  name: localized,
  category: z.object({ slug: z.string(), name: localized }),
  distanceMeters: z.number(),
});

export const bazarCardSchema = z.object({
  kind: z.literal('bazar_prices'),
  /** Today in Asia/Dhaka, YYYY-MM-DD. */
  date: z.string(),
  items: z.array(
    z.object({
      commodity: z.string(),
      name: localized,
      unit: z.string(),
      minPrice: z.string(),
      maxPrice: z.string(),
    }),
  ),
});

export const emergencyCardSchema = z.object({
  kind: z.literal('emergency'),
  hotlines: z.array(z.object({ serviceType: z.string(), name: localized, dial: z.string() })),
});

export const feedItemSchema = z.discriminatedUnion('kind', [
  postCardSchema,
  storeCardSchema,
  landmarkCardSchema,
  bazarCardSchema,
  emergencyCardSchema,
]);
export type FeedItem = z.infer<typeof feedItemSchema>;
export type PostCard = z.infer<typeof postCardSchema>;
export type StoreCard = z.infer<typeof storeCardSchema>;
export type LandmarkCard = z.infer<typeof landmarkCardSchema>;
export type BazarCard = z.infer<typeof bazarCardSchema>;
export type EmergencyCard = z.infer<typeof emergencyCardSchema>;

export const feedResponseSchema = z.object({
  items: z.array(feedItemSchema),
  /** Pass back as `cursor` with the same scope/category/filters/radius; null at the end. */
  nextCursor: z.string().nullable(),
  scope: z.enum(FEED_SCOPES),
  /** The radius actually used; null for the country scope. */
  radiusKm: z.number().nullable(),
});
export type FeedResponse = z.infer<typeof feedResponseSchema>;
export class FeedResponseDto extends createZodDto(feedResponseSchema) {}

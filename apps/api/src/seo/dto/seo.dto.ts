import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { postCardSchema } from '../../feed/dto/feed.dto';

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });

// ---- requests --------------------------------------------------------------

export const listingIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class ListingIdParamDto extends createZodDto(listingIdParamSchema) {}

export const storeSlugParamSchema = z
  .object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) })
  .strict();
export class StoreSlugParamDto extends createZodDto(storeSlugParamSchema) {}

export const sitemapPageQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    /** Capped at sitemap_urls_per_file. */
    limit: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export type SitemapPageQuery = z.infer<typeof sitemapPageQuerySchema>;
export class SitemapPageQueryDto extends createZodDto(sitemapPageQuerySchema) {}

export const storePostsQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export type StorePostsQuery = z.infer<typeof storePostsQuerySchema>;
export class StorePostsQueryDto extends createZodDto(storePostsQuerySchema) {}

// ---- responses -------------------------------------------------------------

export const LISTING_STATES = ['live', 'sold', 'gone', 'not_found'] as const;

/**
 * What a public listing URL should answer (ADR 039): live/sold render (sold
 * noindex after sold_noindex_days), gone is 410, not_found is 404.
 */
export const listingStatusSchema = z.object({
  state: z.enum(LISTING_STATES),
  /** The owning tenant: the canonical host. Null for not_found. */
  tenantId: z.string().nullable(),
  tenantSlug: z.string().nullable(),
  /** For the canonical slug; only for live and sold. */
  title: z.string().nullable(),
  indexable: z.boolean(),
  soldAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ListingStatus = z.infer<typeof listingStatusSchema>;
export class ListingStatusDto extends createZodDto(listingStatusSchema) {}

export const sitemapSummarySchema = z.object({
  posts: z.number(),
  stores: z.number(),
  urlsPerFile: z.number(),
});
export type SitemapSummary = z.infer<typeof sitemapSummarySchema>;
export class SitemapSummaryDto extends createZodDto(sitemapSummarySchema) {}

export const sitemapPostsSchema = z.object({
  items: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.string() })),
});
export type SitemapPosts = z.infer<typeof sitemapPostsSchema>;
export class SitemapPostsDto extends createZodDto(sitemapPostsSchema) {}

export const sitemapStoresSchema = z.object({
  items: z.array(z.object({ slug: z.string(), updatedAt: z.string() })),
});
export type SitemapStores = z.infer<typeof sitemapStoresSchema>;
export class SitemapStoresDto extends createZodDto(sitemapStoresSchema) {}

const image = z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable();

/** GET /stores/:slug — a store's public page. Never its phone number. */
export const storePageSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  name: localized,
  description: z.string().nullable(),
  addressText: z.string().nullable(),
  area: localized.nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  logo: image,
  cover: image,
  isVerified: z.boolean(),
  rating: z.number().nullable(),
  ratingCount: z.number(),
  followerCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  posts: z.array(postCardSchema),
  nextCursor: z.string().nullable(),
});
export type StorePage = z.infer<typeof storePageSchema>;
export class StorePageDto extends createZodDto(storePageSchema) {}

// ---- category + area landing pages (ADR 042) ---------------------------

const bnName = z.object({ bn: z.string(), en: z.string().nullable() });

/**
 * GET /seo/category-areas: the host tenant's category + area pairs with at
 * least `minListings` listings (seo_area_page_min_listings) — the landing
 * pages that exist. Counted with the same search criteria the page shows.
 */
export const categoryAreasSchema = z.object({
  minListings: z.number().int(),
  items: z.array(
    z.object({
      category: z.object({ slug: z.string(), name: bnName }),
      area: z.object({ slug: z.string(), name: bnName }),
      count: z.number().int(),
    }),
  ),
});
export type CategoryAreas = z.infer<typeof categoryAreasSchema>;
export class CategoryAreasDto extends createZodDto(categoryAreasSchema) {}

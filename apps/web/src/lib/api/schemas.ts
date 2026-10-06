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
  /**
   * The public pages' cache windows and SEO rules (settings, ADR 039).
   * Optional: an older cached config may not carry it — then nothing is
   * cached and sitemaps use the protocol's own cap.
   */
  web: z
    .object({
      homeRevalidateSeconds: z.number(),
      categoryRevalidateSeconds: z.number(),
      listingRevalidateSeconds: z.number(),
      soldNoindexDays: z.number(),
      sitemapUrlsPerFile: z.number(),
    })
    .optional(),
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
/** GET /geo/autocomplete (ADR 044): our own places, landmarks, stores and areas first. */
export const geocodeResultSchema = z.object({
  label: z.string(),
  labelBn: z.string().nullable(),
  location: point,
  area: z.string().nullable(),
  city: z.string().nullable(),
  /** `own` (our data) or `barikoi` (show its attribution). */
  source: z.enum(['own', 'barikoi']),
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;
export const geocodeResponseSchema = z.object({
  results: z.array(geocodeResultSchema),
  degraded: z.boolean(),
});
/** GET /geo/reverse: areas from our geo_areas always; a Barikoi address only for purposes that show one. */
export const reverseGeocodeSchema = z.object({
  address: z
    .object({
      label: z.string(),
      labelBn: z.string().nullable(),
      source: z.literal('barikoi'),
    })
    .nullable(),
  areas: z.array(
    z.object({ level: z.string(), name: z.object({ bn: z.string().nullable(), en: z.string() }) }),
  ),
  degraded: z.boolean(),
});
export type ReverseGeocode = z.infer<typeof reverseGeocodeSchema>;

export type _GeoContract = [
  Assert<Accepts<z.infer<typeof geocodeResponseSchema>, Api['GeoAutocompleteResponseDto']>>,
  Assert<Accepts<ReverseGeocode, Api['GeoReverseResponseDto']>>,
];

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

// ---- post detail and share links (ADR 036) -----------------------------------

const localizedText = z.object({ bn: z.string().nullable(), en: z.string().nullable() });
const mediaVariant = z.object({ url: z.string(), width: z.number(), height: z.number() });

export const shortLinkSchema = z.object({
  code: z.string(),
  postId: z.string(),
  tenantId: z.string(),
  tenantSlug: z.string(),
  url: z.string(),
});
export type ShortLink = z.infer<typeof shortLinkSchema>;

/** What the share page reads of GET /posts/:id/detail (never a phone number: the API has none there). */
/** A post card as the feed, search-free lists and "similar posts" send it. */
export const postCardSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  title: z.string(),
  price: z.string().nullable(),
  cover: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
  distanceMeters: z.number().nullable(),
  area: localizedText.nullable(),
  badges: z.array(z.string()),
  createdAt: z.string(),
});
export type PostCard = z.infer<typeof postCardSchema>;

/** GET /posts/:id/detail as the public pages read it (never a phone number: the API has none there). */
export const postDetailSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(POST_STATUSES),
  isSold: z.boolean(),
  title: z.string(),
  description: z.string().nullable(),
  price: z.string().nullable(),
  priceType: z.string().nullable(),
  currency: z.string(),
  category: z.object({ id: z.string(), slug: z.string(), name: localizedText }),
  fields: z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      label: localizedText,
      value: z.unknown(),
      optionLabels: z.array(localizedText).optional(),
    }),
  ),
  media: z.array(
    z.object({
      id: z.string(),
      thumbhash: z.string().nullable(),
      variants: z
        .object({ thumb: mediaVariant, card: mediaVariant, full: mediaVariant })
        .nullable(),
    }),
  ),
  location: point.nullable(),
  area: localizedText.nullable(),
  seller: z.object({
    name: z.string().nullable(),
    memberSince: z.string().nullable(),
    badges: z.array(z.string()),
    store: z
      .object({ id: z.string(), slug: z.string(), name: localizedText, verified: z.boolean() })
      .nullable(),
  }),
  contact: z.object({
    name: z.string().nullable(),
    channels: z.array(z.string()),
    allowChat: z.boolean(),
    loginRequired: z.boolean(),
  }),
  share: z.object({ code: z.string(), url: z.string() }).nullable(),
  similar: z.array(postCardSchema),
  publishedAt: z.string().nullable(),
  soldAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PostDetail = z.infer<typeof postDetailSchema>;

export type _PostDetailContract = [
  Assert<Accepts<ShortLink, Api['ShortLinkDto']>>,
  Assert<Accepts<PostDetail, Api['PostDetailDto']>>,
];

// ---- public listing pages (ADR 039) ---------------------------------------------

export const listingStatusSchema = z.object({
  state: z.enum(['live', 'sold', 'gone', 'not_found']),
  tenantId: z.string().nullable(),
  tenantSlug: z.string().nullable(),
  title: z.string().nullable(),
  indexable: z.boolean(),
  soldAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ListingStatus = z.infer<typeof listingStatusSchema>;

export const sitemapSummarySchema = z.object({
  posts: z.number(),
  stores: z.number(),
  urlsPerFile: z.number(),
});
export const sitemapPostsSchema = z.object({
  items: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.string() })),
});
export const sitemapStoresSchema = z.object({
  items: z.array(z.object({ slug: z.string(), updatedAt: z.string() })),
});

const image = z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable();

export const storePageSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  name: localizedText,
  description: z.string().nullable(),
  addressText: z.string().nullable(),
  area: localizedText.nullable(),
  location: point.nullable(),
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

/** GET /search (posts), as the category page and "recent" read it. */
export const searchHitSchema = z.object({
  id: z.string(),
  name: localizedText,
  area: localizedText.nullable(),
  category: z.object({ id: z.string(), slug: z.string(), name: localizedText }).nullable(),
  isBoosted: z.boolean(),
  publishedAt: z.string(),
  price: z.string().nullable(),
  cover: z.object({ thumbUrl: z.string(), thumbhash: z.string().nullable() }).nullable(),
  isVerified: z.boolean(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

const facetCount = z.object({ value: z.string(), count: z.number() });

/** The filter UI's facets (ADR 040): counts beside every choice. */
export const searchFacetsSchema = z.object({
  categories: z.array(z.object({ slug: z.string(), count: z.number() })),
  price: z
    .object({
      min: z.string(),
      max: z.string(),
      buckets: z.array(
        z.object({ min: z.string(), max: z.string().nullable(), count: z.number() }),
      ),
    })
    .nullable(),
  fields: z.record(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('values'), values: z.array(facetCount) }),
      z.object({
        kind: z.literal('range'),
        min: z.union([z.number(), z.string()]),
        max: z.union([z.number(), z.string()]),
      }),
    ]),
  ),
});
export type SearchFacets = z.infer<typeof searchFacetsSchema>;

export const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
  /** For POST /search/click; null when nothing was logged. */
  searchId: z.string().nullable(),
  page: z.number(),
  limit: z.number(),
  totalHits: z.number(),
  radiusKm: z.number().nullable(),
  /** The area of an area search (landing pages, ADR 042). */
  area: z
    .object({ slug: z.string(), name: z.object({ bn: z.string(), en: z.string().nullable() }) })
    .nullable(),
  facets: searchFacetsSchema,
  degraded: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** The feed's info cards (the home page shows them); other kinds are skipped. */
export const bazarCardSchema = z.object({
  kind: z.literal('bazar_prices'),
  date: z.string(),
  items: z.array(
    z.object({
      commodity: z.string(),
      name: localizedText,
      unit: z.string(),
      minPrice: z.string(),
      maxPrice: z.string(),
    }),
  ),
});
export const emergencyCardSchema = z.object({
  kind: z.literal('emergency'),
  hotlines: z.array(z.object({ serviceType: z.string(), name: localizedText, dial: z.string() })),
});
export type BazarCard = z.infer<typeof bazarCardSchema>;
export type EmergencyCard = z.infer<typeof emergencyCardSchema>;

/** The feed page as the home reads it: each item is checked by its own kind's schema (infoCards). */
export const feedInfoSchema = z.object({ items: z.array(z.unknown()) });

export const contactRevealSchema = z.object({
  channel: z.string(),
  name: z.string().nullable(),
  phone: z.string(),
  href: z.string(),
  message: z.string().nullable(),
});
export type ContactReveal = z.infer<typeof contactRevealSchema>;

/** GET /search/suggest (ADR 040), as the header's dropdown reads it. */
export const suggestResponseSchema = z.object({
  query: z.string(),
  categories: z.array(z.object({ slug: z.string(), name: localizedText })),
  queries: z.array(z.object({ query: z.string() })),
  listings: z.array(
    z.object({
      id: z.string(),
      tenantId: z.string(),
      title: localizedText,
      categorySlug: z.string().nullable(),
    }),
  ),
  degraded: z.boolean(),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;

/** GET /seo/category-areas (ADR 042): the category + area landing pages that exist. */
export const categoryAreasSchema = z.object({
  minListings: z.number(),
  items: z.array(
    z.object({
      category: z.object({
        slug: z.string(),
        name: z.object({ bn: z.string(), en: z.string().nullable() }),
      }),
      area: z.object({
        slug: z.string(),
        name: z.object({ bn: z.string(), en: z.string().nullable() }),
      }),
      count: z.number(),
    }),
  ),
});
export type CategoryAreas = z.infer<typeof categoryAreasSchema>;

/** POST /saved-searches' answer: only what the page confirms with. */
export const savedSearchCreatedSchema = z.object({ id: z.string(), name: z.string() });

export type _PublicPagesContract = [
  Assert<Accepts<ListingStatus, Api['ListingStatusDto']>>,
  Assert<Accepts<z.infer<typeof sitemapSummarySchema>, Api['SitemapSummaryDto']>>,
  Assert<Accepts<z.infer<typeof sitemapPostsSchema>, Api['SitemapPostsDto']>>,
  Assert<Accepts<z.infer<typeof sitemapStoresSchema>, Api['SitemapStoresDto']>>,
  Assert<Accepts<StorePage, Api['StorePageDto']>>,
  Assert<Accepts<SearchResponse, Api['SearchResponseDto']>>,
  Assert<Accepts<SuggestResponse, Api['SuggestResponseDto']>>,
  Assert<Accepts<CategoryAreas, Api['CategoryAreasDto']>>,
  Assert<Accepts<z.infer<typeof savedSearchCreatedSchema>, Api['SavedSearchDto']>>,
  Assert<Accepts<ContactReveal, Api['ContactRevealDto']>>,
  Assert<Accepts<TenantConfig, Api['TenantConfigDto']>>,
];

// ---- base map (ADR 043) -------------------------------------------------------

/** GET /map/config: the live tiles archive, where fonts and sprites are, and the label language. */
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
  fallbackStyleUrl: z.string().nullable(),
});
export type MapConfig = z.infer<typeof mapConfigSchema>;

export type _MapContract = [Assert<Accepts<MapConfig, Api['MapConfigDto']>>];

// ---- map features (ADR 045) and routes (ADR 044) -------------------------------

export const MAP_LAYERS = ['posts', 'stores', 'places', 'landmarks', 'info'] as const;
const mapLayer = z.enum(MAP_LAYERS);
const pointGeometry = z.object({
  type: z.literal('Point'),
  /** [lng, lat] */
  coordinates: z.array(z.number()).length(2),
});
const mapClusterFeature = z.object({
  type: z.literal('Feature'),
  geometry: pointGeometry,
  properties: z.object({
    cluster: z.literal(true),
    layer: mapLayer,
    count: z.number(),
    expansion_zoom: z.number(),
  }),
});
const mapPointFeature = z.object({
  type: z.literal('Feature'),
  id: z.string(),
  geometry: pointGeometry,
  properties: z.object({
    cluster: z.literal(false),
    layer: mapLayer,
    id: z.string(),
    tenant_id: z.string(),
    name_bn: z.string().nullable(),
    name_en: z.string().nullable(),
    category_slug: z.string().nullable(),
    price: z.string().nullable(),
    slug: z.string().nullable(),
    info_kind: z.string().nullable(),
    open_now: z.boolean().nullable(),
  }),
});
export const mapFeaturesResponseSchema = z.object({
  type: z.literal('FeatureCollection'),
  zoom: z.number(),
  layers: z.array(mapLayer),
  clustered: z.boolean(),
  clipped: z.boolean(),
  truncated: z.boolean(),
  open_now_skipped: z.array(mapLayer),
  features: z.array(z.union([mapClusterFeature, mapPointFeature])),
});
export type MapLayer = z.infer<typeof mapLayer>;
export type MapFeatures = z.infer<typeof mapFeaturesResponseSchema>;
export type MapFeature = MapFeatures['features'][number];
export type MapPointFeature = z.infer<typeof mapPointFeature>;
export type MapClusterFeature = z.infer<typeof mapClusterFeature>;

export const routeResponseSchema = z.object({
  mode: z.enum(['car', 'foot']),
  distanceMeters: z.number(),
  durationSeconds: z.number().nullable(),
  /** GeoJSON LineString coordinates ([lng, lat] pairs); null when degraded. */
  polyline: z.array(z.array(z.number()).length(2)).nullable(),
  source: z.enum(['barikoi', 'straight_line']),
  degraded: z.boolean(),
});
export type RouteAnswer = z.infer<typeof routeResponseSchema>;

export type _MapFeaturesContract = [
  Assert<Accepts<MapFeatures, Api['MapFeaturesResponseDto']>>,
  Assert<Accepts<RouteAnswer, Api['GeoRouteResponseDto']>>,
];

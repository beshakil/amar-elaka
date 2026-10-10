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
   * The photo limits (post_max_media, media_variant_full_px, media_image_quality);
   * optional for an older API.
   */
  media: z
    .object({
      postMaxPhotos: z.number(),
      imageMaxLongEdgePx: z.number(),
      imageQuality: z.number().optional(),
    })
    .optional(),
  /** search_suggest_min_chars; optional for an older API. */
  search: z.object({ suggestMinChars: z.number() }).optional(),
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
export type GeoAreaName = ReverseGeocode['areas'][number];

/** GET /locations/lookup: our own areas at a point (free) — LocationPicker's instant area name. */
export const pointAreasSchema = z.object({ areas: reverseGeocodeSchema.shape.areas });
export type PointAreas = z.infer<typeof pointAreasSchema>;

export type _GeoContract = [
  Assert<Accepts<z.infer<typeof geocodeResponseSchema>, Api['GeoAutocompleteResponseDto']>>,
  Assert<Accepts<ReverseGeocode, Api['GeoReverseResponseDto']>>,
  Assert<Accepts<PointAreas, Api['PointLookupDto']>>,
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

/**
 * GET /stores/:slug/catalog (ADR 056): the WhatsApp catalog. No phone number
 * anywhere in it: ordering goes through the order route, which records the lead.
 */
export const storeCatalogSchema = z.object({
  store: z.object({
    id: z.string(),
    tenantId: z.string(),
    slug: z.string(),
    name: localizedText,
    description: z.string().nullable(),
    logo: z.object({ url: z.string() }).nullable(),
    cover: z.object({ url: z.string() }).nullable(),
    orderable: z.boolean(),
  }),
  products: z.array(
    z.object({
      postId: z.string(),
      title: z.string(),
      price: z.string().nullable(),
      priceType: z.string().nullable(),
      stockStatus: z.enum(['in_stock', 'out_of_stock', 'on_order']),
      photo: z
        .object({
          url: z.string(),
          width: z.number(),
          height: z.number(),
          thumbhash: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  shareImagePath: z.string(),
});
export type StoreCatalog = z.infer<typeof storeCatalogSchema>;

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

/** POST /saved/:type/:id: `created` false when it was already saved. */
export const saveResultSchema = z.object({ created: z.boolean() }).passthrough();

export type _PublicPagesContract = [
  Assert<Accepts<ListingStatus, Api['ListingStatusDto']>>,
  Assert<Accepts<z.infer<typeof sitemapSummarySchema>, Api['SitemapSummaryDto']>>,
  Assert<Accepts<z.infer<typeof sitemapPostsSchema>, Api['SitemapPostsDto']>>,
  Assert<Accepts<z.infer<typeof sitemapStoresSchema>, Api['SitemapStoresDto']>>,
  Assert<Accepts<StorePage, Api['StorePageDto']>>,
  Assert<Accepts<StoreCatalog, Api['StoreCatalogDto']>>,
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
  /** map_kinds: the map's toggles, in order (ADR 046). */
  kinds: z.array(
    z.object({
      code: z.string(),
      icon: z.string(),
      label: z.object({ bn: z.string(), en: z.string() }),
    }),
  ),
  /** Timings and limits the clients obey (settings, ADR 046). */
  client: z.object({
    pickerIdleDebounceMs: z.number(),
    autocompleteDebounceMs: z.number(),
    autocompleteMinChars: z.number(),
    searchAreaMoveRatio: z.number(),
    pinLabelMinZoom: z.number(),
    pinLabelMax: z.number(),
  }),
});
export type MapKind = MapConfig['kinds'][number];
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
    kind: z.string().nullable(),
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
    kind: z.string().nullable(),
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

/** GET /map/features/:layer/:id?tenant= (ADR 046): the preview panel's photo, phones, address. */
export const mapPreviewSchema = z.object({
  layer: mapLayer,
  id: z.string(),
  tenantId: z.string(),
  name: z.object({ bn: z.string().nullable(), en: z.string().nullable() }),
  photo: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
  phones: z.array(z.string()),
  address: z.string().nullable(),
});
export type MapPreview = z.infer<typeof mapPreviewSchema>;

/** GET /map/distance: straight-line metres (PostGIS, free). */
export const mapDistanceSchema = z.object({ straight_line_meters: z.number() });

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
  Assert<Accepts<MapPreview, Api['MapPreviewResponseDto']>>,
  Assert<Accepts<z.infer<typeof mapDistanceSchema>, Api['MapDistanceResponseDto']>>,
  Assert<Accepts<RouteAnswer, Api['GeoRouteResponseDto']>>,
];

// ---- the seller panel (ADR 057) ------------------------------------------------

export const STORE_ROLES = ['owner', 'manager', 'editor'] as const;
export const STOCK_STATUSES = ['in_stock', 'out_of_stock', 'on_order'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** GET /stores/me: the stores the seller owns or staffs (invitations included). */
export const myStoresSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      tenantId: z.string(),
      slug: z.string(),
      name: localizedText,
      status: z.enum(['pending_review', 'active', 'suspended', 'closed']),
      role: z.enum(STORE_ROLES),
      accepted: z.boolean(),
    }),
  ),
});
export type MyStores = z.infer<typeof myStoresSchema>;

/** GET /stores/:id/manage, as the panel reads it. */
export const sellerStoreSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  slug: z.string(),
  name: localizedText,
  status: z.enum(['pending_review', 'active', 'suspended', 'closed']),
  myRole: z.enum(STORE_ROLES),
  catalogUrl: z.string(),
  counts: z.object({ staff: z.number(), catalog: z.number() }),
  limits: z.object({ staff: z.number(), catalog: z.number() }),
});
export type SellerStore = z.infer<typeof sellerStoreSchema>;

const contactsSchema = z.object({
  total: z.number(),
  call: z.number(),
  whatsapp: z.number(),
  sms: z.number(),
  chat: z.number(),
});
const metricsSchema = z.object({
  views: z.number(),
  uniqueViewers: z.number(),
  contacts: contactsSchema,
  uniqueContacters: z.number(),
  saves: z.number(),
  shares: z.number(),
  searchAppearances: z.number(),
  mapTaps: z.number(),
  conversionRate: z.number(),
});

/** GET /stores/:id/analytics (ADR 055). */
export const sellerAnalyticsSchema = z.object({
  period: z.object({
    days: z.number(),
    from: z.string(),
    to: z.string(),
    available: z.array(z.number()),
  }),
  summary: z.object({ bn: z.string(), en: z.string() }),
  totals: metricsSchema,
  trend: z.object({
    views: z.number().nullable(),
    contacts: z.number().nullable(),
    uniqueContacters: z.number().nullable(),
    saves: z.number().nullable(),
  }),
  daily: z.array(z.object({ date: z.string(), views: z.number(), contacts: z.number() })),
  topPosts: z.array(
    z.object({ postId: z.string(), title: z.string(), status: z.string(), metrics: metricsSchema }),
  ),
  topQueries: z.array(z.object({ query: z.string(), searchers: z.number(), clicks: z.number() })),
});
export type SellerAnalytics = z.infer<typeof sellerAnalyticsSchema>;

/** GET /stores/:id/products: the product table (ADR 057). */
export const storeProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  categoryId: z.string(),
  price: z.string().nullable(),
  priceType: z.string().nullable(),
  status: z.enum(POST_STATUSES),
  stockStatus: z.enum(STOCK_STATUSES),
  hidden: z.boolean(),
  thumbUrl: z.string().nullable(),
  views: z.number(),
  saves: z.number(),
  expiresAt: z.string().nullable(),
  updatedAt: z.string(),
  isMine: z.boolean(),
  canManage: z.boolean(),
});
export type StoreProduct = z.infer<typeof storeProductSchema>;
export const storeProductsSchema = z.object({
  items: z.array(storeProductSchema),
  nextCursor: z.string().nullable(),
});
export type StoreProducts = z.infer<typeof storeProductsSchema>;

/** A bulk import's progress and, when asked, its rows (ADR 056). */
export const importViewSchema = z.object({
  id: z.string(),
  dryRun: z.boolean(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  errorCode: z.string().nullable(),
  progress: z.object({
    totalRows: z.number().nullable(),
    processedRows: z.number(),
    created: z.number(),
    skipped: z.number(),
    failed: z.number(),
  }),
  createdAt: z.string(),
  rows: z
    .array(
      z.object({
        row: z.number(),
        outcome: z.enum(['created', 'valid', 'skipped', 'failed']),
        reasonCode: z.string().nullable(),
        reason: z.string().nullable(),
        postId: z.string().nullable(),
      }),
    )
    .optional(),
});
export type ImportView = z.infer<typeof importViewSchema>;
export const importListSchema = z.object({ items: z.array(importViewSchema) });

export type _SellerPanelContract = [
  Assert<Accepts<MyStores, Api['MyStoresDto']>>,
  Assert<Accepts<SellerStore, Api['StoreViewDto']>>,
  Assert<Accepts<SellerAnalytics, Api['SellerAnalyticsDto']>>,
  Assert<Accepts<StoreProducts, Api['StoreProductsDto']>>,
  Assert<Accepts<ImportView, Api['ImportViewDto']>>,
  Assert<Accepts<z.infer<typeof importListSchema>, Api['ImportListDto']>>,
];

// ---- chat (ADR 058/060) -----------------------------------------------------

const chatCoverSchema = z.object({ url: z.string(), thumbhash: z.string().nullable() });
const chatImageVariantSchema = z.object({ url: z.string(), width: z.number(), height: z.number() });
const participantRoleSchema = z.enum(['buyer', 'seller', 'store_staff']);

export const chatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  clientMessageId: z.string(),
  senderMemberId: z.string().nullable(),
  senderRole: participantRoleSchema.nullable(),
  kind: z.enum(['text', 'image', 'location', 'listing_card', 'system']),
  body: z.string().nullable(),
  image: z
    .object({
      thumb: chatImageVariantSchema,
      card: chatImageVariantSchema,
      full: chatImageVariantSchema,
      thumbhash: z.string().nullable(),
    })
    .nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  listing: z
    .discriminatedUnion('state', [
      z.object({
        state: z.literal('shared'),
        postId: z.string(),
        tenantId: z.string(),
        title: z.string(),
        price: z.string().nullable(),
        cover: chatCoverSchema.nullable(),
      }),
      z.object({ state: z.literal('listing_removed') }),
    ])
    .nullable(),
  systemEvent: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(['post_inquiry', 'store_inquiry', 'direct']),
  post: z
    .object({
      id: z.string(),
      title: z.string(),
      price: z.string().nullable(),
      cover: chatCoverSchema.nullable(),
    })
    .nullable(),
  postRemoved: z.boolean(),
  store: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.object({ bn: z.string(), en: z.string().nullable() }),
    })
    .nullable(),
  counterpart: z.object({
    kind: z.enum(['buyer', 'seller', 'store']),
    name: z.string().nullable(),
  }),
  me: z.object({ memberId: z.string(), role: participantRoleSchema }),
  unreadCount: z.number(),
  isArchived: z.boolean(),
  isLocked: z.boolean(),
  isBlocked: z.boolean(),
  blockedByMe: z.boolean(),
  canSend: z.boolean(),
  othersDeliveredUpTo: z.string().nullable(),
  othersReadUpTo: z.string().nullable(),
  myReadUpTo: z.string().nullable(),
  lastMessage: chatMessageSchema.nullable(),
  activityAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const chatInboxSchema = z.object({
  items: z.array(conversationSchema),
  nextCursor: z.string().nullable(),
});
export type ChatInbox = z.infer<typeof chatInboxSchema>;
export const openConversationSchema = z.object({
  conversation: conversationSchema,
  created: z.boolean(),
});
export const chatHistorySchema = z.object({
  items: z.array(chatMessageSchema),
  hasMore: z.boolean(),
});
export type ChatHistory = z.infer<typeof chatHistorySchema>;
export const sendResultSchema = z.object({ message: chatMessageSchema, created: z.boolean() });
export type SendResult = z.infer<typeof sendResultSchema>;
export const receiptResultSchema = z.object({
  conversationId: z.string(),
  memberId: z.string(),
  deliveredUpTo: z.string().nullable(),
  readUpTo: z.string().nullable(),
  unreadCount: z.number(),
});
export const chatReportResultSchema = z.object({ reportId: z.string(), created: z.boolean() });
export const chatImagePresignedSchema = z.object({
  mediaId: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    expiresInSeconds: z.number(),
  }),
});
export type ChatImagePresigned = z.infer<typeof chatImagePresignedSchema>;
export const chatImageStatusSchema = z.object({
  mediaId: z.string(),
  status: z.enum(['pending_upload', 'processing', 'ready', 'rejected', 'quarantined']),
});
export const quickReplyListSchema = z.object({
  items: z.array(z.object({ id: z.string(), body: z.string(), sortOrder: z.number() })),
  max: z.number(),
  maxLength: z.number(),
});
export type QuickReplyList = z.infer<typeof quickReplyListSchema>;

// ---- notifications (ADR 059/060) ---------------------------------------------

export const notificationInboxSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string().nullable(),
      body: z.string().nullable(),
      count: z.number(),
      params: z.record(z.string().nullable()),
      deepLink: z.string().nullable(),
      entityId: z.string().nullable(),
      read: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  unreadCount: z.number(),
});
export type NotificationInbox = z.infer<typeof notificationInboxSchema>;
export type NotificationItem = NotificationInbox['items'][number];
export const unreadCountSchema = z.object({ unreadCount: z.number() });
export const notificationPreferencesSchema = z.object({
  items: z.array(
    z.object({
      type: z.string(),
      urgent: z.boolean(),
      channels: z.array(
        z.object({
          channel: z.enum(['in_app', 'push', 'sms', 'email']),
          enabled: z.boolean(),
          locked: z.boolean(),
        }),
      ),
    }),
  ),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export type _ChatContract = [
  Assert<Accepts<ChatMessage, Api['SendResultDto']['message']>>,
  Assert<Accepts<Conversation, Api['ConversationViewDto']>>,
  Assert<Accepts<ChatInbox, Api['ChatInboxPageDto']>>,
  Assert<Accepts<z.infer<typeof openConversationSchema>, Api['OpenConversationResultDto']>>,
  Assert<Accepts<ChatHistory, Api['HistoryPageDto']>>,
  Assert<Accepts<SendResult, Api['SendResultDto']>>,
  Assert<Accepts<z.infer<typeof receiptResultSchema>, Api['ReceiptResultDto']>>,
  Assert<Accepts<z.infer<typeof chatReportResultSchema>, Api['ChatReportResultDto']>>,
  Assert<Accepts<ChatImagePresigned, Api['ChatImagePresignedDto']>>,
  Assert<Accepts<z.infer<typeof chatImageStatusSchema>, Api['ChatImageStatusDto']>>,
  Assert<Accepts<QuickReplyList, Api['QuickReplyListDto']>>,
  Assert<Accepts<NotificationInbox, Api['InboxPageDto']>>,
  Assert<Accepts<z.infer<typeof unreadCountSchema>, Api['UnreadCountDto']>>,
  Assert<Accepts<NotificationPreferences, Api['PreferencesDto']>>,
];

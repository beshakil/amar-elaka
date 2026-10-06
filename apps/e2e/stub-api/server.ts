/**
 * A stand-in for the Amar Elaka API that the end-to-end suite runs the real,
 * production-built web and admin apps against — no Postgres, Redis or
 * Meilisearch needed.
 *
 * Every response body is typed against the API's published OpenAPI schemas
 * (`@amar-elaka/shared-types`), so if the API contract changes and
 * `pnpm gen:api` regenerates the types, this stub fails typecheck until it is
 * brought back in line. It can't silently drift into testing a contract that
 * no longer exists.
 *
 * Test-only endpoints: `POST /__control` (reset state, simulate an outage,
 * shorten token lifetimes) and `GET /__stats` (call counts).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { components } from '@amar-elaka/shared-types';
import {
  OTP_CODE,
  PASSWORD,
  PERSONAS,
  PHONE_CATEGORY_ID,
  SELLER_PHONE,
  STORE_SLUG,
  STUB_PORT,
  STUB_URL,
  TENANT_MIRPUR,
  TENANT_SAVAR,
} from './fixtures';

type Schemas = components['schemas'];
type Role = Schemas['RoleDto'];
type Grant = Role['permissions'][number];

const PREFIX = '/api/v1';
/** sold_noindex_days, as seeded. */
const SOLD_NOINDEX_DAYS = 90;

const tenants: Schemas['TenantSummaryDto'][] = [
  {
    id: TENANT_MIRPUR,
    slug: 'mirpur',
    nameBn: 'মিরপুর',
    nameEn: 'Mirpur',
    mapCenter: { lat: 23.8, lng: 90.36 },
    districtNameBn: 'ঢাকা',
    districtNameEn: 'Dhaka',
  },
  {
    id: TENANT_SAVAR,
    slug: 'savar',
    nameBn: 'সাভার',
    nameEn: 'Savar',
    mapCenter: { lat: 23.85, lng: 90.26 },
    districtNameBn: 'ঢাকা',
    districtNameEn: 'Dhaka',
  },
];
const customDomains: Record<string, string> = { 'mirpur-bazaar.test': TENANT_MIRPUR };

function tenantConfig(tenant: Schemas['TenantSummaryDto']): Schemas['TenantConfigDto'] {
  return {
    id: tenant.id,
    slug: tenant.slug,
    nameBn: tenant.nameBn,
    nameEn: tenant.nameEn,
    defaultLocale: 'bn',
    mapCenter: tenant.mapCenter,
    radiusKm: 6.5,
    branding: { logoStorageKey: null },
    featureFlags: {},
    enabledCategories: [
      { slug: 'electronics', nameBn: 'ইলেকট্রনিক্স', nameEn: 'Electronics', iconKey: null },
      { slug: 'food', nameBn: 'খাবার', nameEn: 'Food', iconKey: 'food' },
      { slug: 'mobile-phones', nameBn: 'মোবাইল ফোন', nameEn: 'Mobile phones', iconKey: null },
    ],
    emergencyNumbers:
      tenant.id === TENANT_MIRPUR
        ? [
            {
              serviceType: 'police',
              nameBn: 'মিরপুর থানা',
              nameEn: null,
              phones: ['+8801320000000'],
              is24h: true,
            },
          ]
        : [],
    support: { phoneE164: '+8801700000000', email: `help@${tenant.slug}.test`, whatsappE164: null },
    moderation: { typicalReviewHours: 12 },
    // The shortest cache windows, so tests see their own changes after one
    // stale response (Next serves stale while it refreshes).
    web: {
      homeRevalidateSeconds: 1,
      categoryRevalidateSeconds: 1,
      listingRevalidateSeconds: 1,
      soldNoindexDays: SOLD_NOINDEX_DAYS,
      sitemapUrlsPerFile: state.sitemapUrlsPerFile,
    },
  };
}

interface Persona {
  userId: string;
  tenantId: string;
  role: Schemas['MeResultDto']['role'];
  isPlatformAdmin: boolean;
  grants: Grant[];
  displayName: string;
}

const personas: Record<string, Persona> = {
  [PERSONAS.tenantAdmin]: {
    userId: randomUUID(),
    tenantId: TENANT_MIRPUR,
    role: 'tenant_admin',
    isPlatformAdmin: false,
    grants: [{ module: '*', action: '*' }],
    displayName: 'এডমিন',
  },
  [PERSONAS.moderator]: {
    userId: randomUUID(),
    tenantId: TENANT_MIRPUR,
    role: 'moderator',
    isPlatformAdmin: false,
    grants: [
      { module: 'posts', action: 'read' },
      { module: 'posts', action: 'approve' },
    ],
    displayName: 'মডারেটর',
  },
  [PERSONAS.seller]: {
    userId: randomUUID(),
    tenantId: TENANT_MIRPUR,
    role: 'member',
    isPlatformAdmin: false,
    grants: [{ module: 'posts', action: 'write' }],
    displayName: 'রহিম বিক্রেতা',
  },
  [PERSONAS.platformAdmin]: {
    userId: randomUUID(),
    tenantId: TENANT_MIRPUR,
    role: 'member',
    isPlatformAdmin: true,
    grants: [{ module: '*', action: '*' }],
    displayName: 'প্ল্যাটফর্ম',
  },
};

const builtinRoles: Role[] = [
  {
    id: randomUUID(),
    code: 'moderator',
    name: 'Moderator',
    isBuiltin: true,
    permissions: [
      { module: 'posts', action: 'read' },
      { module: 'posts', action: 'approve' },
    ],
  },
  {
    id: randomUUID(),
    code: 'marketer',
    name: 'Marketer',
    isBuiltin: true,
    permissions: [{ module: 'campaigns', action: 'write' }],
  },
  {
    id: randomUUID(),
    code: 'member',
    name: 'Member',
    isBuiltin: true,
    permissions: [{ module: 'posts', action: 'write' }],
  },
];

interface State {
  down: boolean;
  accessTtlSeconds: number;
  hits: Record<string, number>;
  refreshTokens: Map<string, { email: string; used: boolean }>;
  customRoles: Map<string, Role[]>;
  posts: Map<string, Schemas['PostDto']>;
  /** Idempotency-Key → the post it created. */
  idempotency: Map<string, string>;
  /** Uploads by media id: whether the bytes arrived at the storage URL. */
  media: Map<string, { stored: boolean }>;
  /** Base map: range requests answered (206), and files asked for that the fixture lacks. */
  mapRanges: number;
  mapMisses: string[];
  /** The last GET /map/features query string, as sent. */
  lastMapQuery: Record<string, string> | null;
  /** `purpose` of the last GET /geo/reverse (decides which Barikoi fields are asked for). */
  lastReversePurpose: string | null;
  /** Posts deleted in this run: their public URLs answer 410 (ADR 039). */
  gone: Set<string>;
  /** sitemap_urls_per_file, lowered by tests to see the sitemap split. */
  sitemapUrlsPerFile: number;
  /** The last /search query the web made, for asserting filters. */
  lastSearch: Record<string, string> | null;
  /** seo_area_page_min_listings: live posts an area needs for its landing page. */
  areaMinListings: number;
  /** POST /saved-searches bodies, in order. */
  savedSearches: Schemas['CreateSavedSearchDto'][];
  /** Answer the next saves with the active-search limit. */
  savedSearchLimit: boolean;
}

function freshState(): State {
  return {
    down: false,
    accessTtlSeconds: 900,
    hits: {},
    refreshTokens: new Map(),
    customRoles: new Map([
      [TENANT_MIRPUR, []],
      [TENANT_SAVAR, []],
    ]),
    posts: new Map(),
    idempotency: new Map(),
    media: new Map(),
    mapRanges: 0,
    mapMisses: [],
    lastMapQuery: null,
    lastReversePurpose: null,
    gone: new Set(),
    sitemapUrlsPerFile: 10_000,
    lastSearch: null,
    areaMinListings: 1,
    savedSearches: [],
    savedSearchLimit: false,
  };
}
let state = freshState();

// ---------------------------------------------------------------------------
// Posts: one postable category, and posts the seller creates in this run.
// ---------------------------------------------------------------------------

const phoneCategory: Schemas['CatalogCategoryDto'] = {
  id: PHONE_CATEGORY_ID,
  parentId: null,
  slug: 'mobile-phones',
  kind: 'marketplace',
  moduleCode: null,
  name: { bn: 'মোবাইল ফোন', en: 'Mobile phones' },
  description: { bn: null, en: null },
  iconKey: 'smartphone',
  postCostCredits: 0,
  postExpiryDays: 30,
  requiresApproval: false,
  fieldSchema: {
    id: randomUUID(),
    version: 1,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] },
        price: {
          'x-field-type': 'money',
          type: 'string',
          'x-money-min': '100.00',
          'x-money-max': '10000000.00',
        },
      },
      required: ['condition', 'price'],
    },
    uiSchema: {
      order: ['condition', 'price'],
      card: ['condition'],
      labels: { condition: { bn: 'অবস্থা', en: 'Condition' }, price: { bn: 'দাম', en: 'Price' } },
      options: {
        condition: { new: { bn: 'নতুন', en: 'New' }, used: { bn: 'ব্যবহৃত', en: 'Used' } },
      },
    },
    filterableFields: ['condition', 'price'],
    searchableFields: [],
    publishedAt: new Date().toISOString(),
  },
};

/** A post's share code in the stub: its id's first 8 hex digits (the API mints random ones). */
const shortCodeOf = (postId: string) => postId.replace(/-/g, '').slice(0, 8);

/** GET /posts/:id/detail, from a stored post — without the number, as the API (ADR 036). */
function detailOf(post: Schemas['PostDto']): Schemas['PostDetailDto'] {
  const ui = phoneCategory.fieldSchema!.uiSchema as {
    order: string[];
    labels: Record<string, { bn: string; en: string }>;
    options: Record<string, Record<string, { bn: string; en: string }>>;
  };
  const tenant = tenants.find((t) => t.id === post.tenantId) ?? tenants[0]!;
  const code = shortCodeOf(post.id);
  return {
    id: post.id,
    tenantId: post.tenantId,
    status: post.status,
    isSold: post.isSold,
    title: post.title,
    description: post.description,
    price: post.price,
    priceType: 'negotiable',
    currency: 'BDT',
    category: { id: PHONE_CATEGORY_ID, slug: phoneCategory.slug, name: phoneCategory.name },
    fieldSchemaVersion: 1,
    fields: ui.order.flatMap((key) => {
      const value = post.fields[key];
      if (value === undefined) return [];
      const option = typeof value === 'string' ? ui.options[key]?.[value] : undefined;
      return [
        {
          key,
          type: key === 'price' ? 'money' : 'select',
          label: ui.labels[key]!,
          value,
          ...(option ? { optionLabels: [option] } : {}),
        },
      ];
    }),
    media: post.media.map((m) => ({
      id: m.id,
      thumbhash: null,
      variants: m.cardUrl
        ? {
            thumb: { url: m.thumbUrl ?? m.cardUrl, width: 200, height: 150 },
            card: { url: m.cardUrl, width: 600, height: 450 },
            full: { url: m.fullUrl ?? m.cardUrl, width: 1200, height: 900 },
          }
        : null,
    })),
    location: post.location,
    area: { bn: 'মিরপুর ১০', en: 'Mirpur 10' },
    distanceMeters: null,
    seller: {
      name: post.contact.name,
      memberSince: '2026-01-15T00:00:00.000Z',
      badges: ['trusted', 'phone_verified'],
      store: null,
      responseHint: null,
    },
    contact: {
      name: post.contact.name,
      channels: post.showPhone ? ['call', 'sms'] : [],
      allowChat: post.allowChat,
      loginRequired: false,
    },
    share: { code, url: `http://${tenant.slug}.localhost:3001/s/${code}` },
    similar: [],
    isMine: false,
    isSaved: false,
    publishedAt: post.publishedAt,
    expiresAt: post.expiresAt,
    soldAt: post.soldAt,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

/** A seeded post, for my-posts tests; `status` and extras as the test needs. */
function seedPost(overrides: Partial<Schemas['PostDto']>): Schemas['PostDto'] {
  const now = new Date().toISOString();
  const post: Schemas['PostDto'] = {
    id: randomUUID(),
    tenantId: TENANT_MIRPUR,
    status: 'live',
    categoryId: PHONE_CATEGORY_ID,
    fieldSchemaId: phoneCategory.fieldSchema!.id,
    fieldSchemaVersion: 1,
    title: 'পুরোনো পোস্ট',
    description: null,
    fields: { condition: 'used', price: '15000.00' },
    price: '15000.00',
    location: { lat: 23.8, lng: 90.36 },
    geoAreaId: null,
    outsideBoundary: false,
    ownershipResolution: 'inside_boundary',
    media: [],
    showPhone: true,
    allowChat: true,
    showWhatsapp: false,
    contact: { name: 'রহিম বিক্রেতা', phone: '+8801711111111', whatsapp: false },
    isSold: false,
    soldAt: null,
    soldPrice: null,
    publishedAt: now,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    bumpedAt: now,
    createdAt: now,
    updatedAt: now,
    isMine: true,
    hiddenByOwner: false,
    moderationReason: null,
    moderationNote: null,
    ...overrides,
  };
  state.posts.set(post.id, post);
  return post;
}

// ---------------------------------------------------------------------------
// The public pages (ADR 039): status, search, store, sitemaps, info cards.
// ---------------------------------------------------------------------------

const SEARCH_PAGE_SIZE = 20;
/** The stub's one area (a locality of Mirpur), for the landing pages (ADR 042). */
const STUB_AREA = { slug: 'mirpur-10', name: { bn: 'মিরপুর ১০', en: 'Mirpur 10' } };
/** A 1×1 PNG: what the web's OG proxy passes through. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const isPublic = (post: Schemas['PostDto']) =>
  !post.hiddenByOwner && (post.status === 'live' || post.status === 'sold');

const isIndexable = (post: Schemas['PostDto']) =>
  post.status === 'live' ||
  (post.status === 'sold' &&
    post.soldAt !== null &&
    Date.now() - Date.parse(post.soldAt) < SOLD_NOINDEX_DAYS * 86_400_000);

function listingStatusOf(id: string): Schemas['ListingStatusDto'] {
  const post = state.posts.get(id);
  const empty = { tenantId: null, tenantSlug: null, title: null, soldAt: null, updatedAt: null };
  if (!post)
    return { state: state.gone.has(id) ? 'gone' : 'not_found', indexable: false, ...empty };
  if (post.status === 'expired' || post.status === 'removed') {
    return { state: 'gone', indexable: false, ...empty, tenantId: post.tenantId };
  }
  if (!isPublic(post)) return { state: 'not_found', indexable: false, ...empty };
  return {
    state: post.status === 'sold' ? 'sold' : 'live',
    tenantId: post.tenantId,
    tenantSlug: tenants.find((t) => t.id === post.tenantId)?.slug ?? null,
    title: post.title,
    indexable: isIndexable(post),
    soldAt: post.soldAt,
    updatedAt: post.updatedAt,
  };
}

function cardOf(post: Schemas['PostDto']): Schemas['StorePageDto']['posts'][number] {
  const media = post.media[0];
  return {
    kind: 'post',
    id: post.id,
    tenantId: post.tenantId,
    title: post.title,
    price: post.price,
    cover: media?.cardUrl ? { url: media.cardUrl, thumbhash: null } : null,
    distanceMeters: null,
    area: { bn: 'মিরপুর ১০', en: 'Mirpur 10' },
    badges: ['negotiable'],
    createdAt: post.createdAt,
    isSaved: false,
  };
}

function hitOf(post: Schemas['PostDto']): Schemas['SearchResponseDto']['hits'][number] {
  const media = post.media[0];
  return {
    id: post.id,
    type: 'posts',
    tenantId: post.tenantId,
    name: { bn: post.title, en: null },
    nameTranslit: '',
    description: post.description,
    category: { id: PHONE_CATEGORY_ID, slug: phoneCategory.slug, name: phoneCategory.name },
    area: { bn: 'মিরপুর ১০', en: 'Mirpur 10' },
    location: post.location,
    distanceMeters: null,
    isBoosted: false,
    publishedAt: post.publishedAt ?? post.createdAt,
    price: post.price,
    cardFields: {},
    rating: null,
    slug: null,
    cover: media?.thumbUrl ? { thumbUrl: media.thumbUrl, thumbhash: null } : null,
    isVerified: false,
    isLandmark: false,
  };
}

/** The live posts a tenant's pages list, newest first. */
const livePosts = (tenantId: string) =>
  [...state.posts.values()]
    .filter((p) => p.tenantId === tenantId && p.status === 'live' && !p.hiddenByOwner)
    .reverse();

function storeOf(tenantId: string): Schemas['StorePageDto'] | null {
  if (tenantId !== TENANT_MIRPUR) return null;
  return {
    id: '0191e3a0-0000-7000-8000-0000000051e0',
    tenantId,
    slug: STORE_SLUG,
    name: { bn: 'রহিম ইলেকট্রনিক্স', en: 'Rahim Electronics' },
    description: 'মিরপুর ১০-এর পুরোনো মোবাইলের দোকান।',
    addressText: 'দোকান ১২, মিরপুর ১০ গোলচত্বর',
    area: { bn: 'মিরপুর ১০', en: 'Mirpur 10' },
    location: { lat: 23.8069, lng: 90.3687 },
    logo: null,
    cover: null,
    isVerified: true,
    rating: 4.5,
    ratingCount: 12,
    followerCount: 30,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    posts: livePosts(tenantId).map(cardOf),
    nextCursor: null,
  };
}

/** The public pages' endpoints; true when it answered. */
async function handlePublic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  tenantId: string,
): Promise<boolean> {
  const statusMatch = /^\/seo\/listing-status\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && statusMatch) {
    send(res, 200, listingStatusOf(statusMatch[1] ?? ''));
    return true;
  }
  const indexed = () =>
    [...state.posts.values()].filter(
      (p) => p.tenantId === tenantId && isPublic(p) && isIndexable(p),
    );
  if (req.method === 'GET' && path === '/seo/sitemap/summary') {
    const summary: Schemas['SitemapSummaryDto'] = {
      posts: indexed().length,
      stores: storeOf(tenantId) ? 1 : 0,
      urlsPerFile: state.sitemapUrlsPerFile,
    };
    send(res, 200, summary);
    return true;
  }
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? String(state.sitemapUrlsPerFile));
  if (req.method === 'GET' && path === '/seo/sitemap/posts') {
    const page: Schemas['SitemapPostsDto'] = {
      items: indexed()
        .slice(offset, offset + limit)
        .map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt })),
    };
    send(res, 200, page);
    return true;
  }
  if (req.method === 'GET' && path === '/seo/sitemap/stores') {
    const store = storeOf(tenantId);
    const page: Schemas['SitemapStoresDto'] = {
      items: store && offset === 0 ? [{ slug: store.slug, updatedAt: store.updatedAt }] : [],
    };
    send(res, 200, page);
    return true;
  }
  const storeMatch = /^\/stores\/([a-z0-9-]+)$/.exec(path);
  if (req.method === 'GET' && storeMatch) {
    const store = storeOf(tenantId);
    if (!store || store.slug !== storeMatch[1]) fail(res, 404, 'STORE_NOT_FOUND');
    else send(res, 200, store);
    return true;
  }
  if (req.method === 'GET' && path === '/search') {
    state.lastSearch = Object.fromEntries(url.searchParams);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const category = url.searchParams.get('category');
    const area = url.searchParams.get('area');
    if (area !== null && area !== STUB_AREA.slug) {
      fail(res, 404, 'SEARCH_AREA_NOT_FOUND');
      return true;
    }
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
    const poisha = (money: string | null) =>
      money === null ? null : Math.round(Number(money) * 100);
    const priceMin = poisha(url.searchParams.get('price_min'));
    const priceMax = poisha(url.searchParams.get('price_max'));
    const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as Record<
      string,
      Record<string, string>
    >;
    // The stub's matching: a title containing the text, the phone category,
    // price bounds, and `condition` (eq / in) — enough for the pages' flows.
    const textMatch = (p: Schemas['PostDto']) => !q || p.title.toLowerCase().includes(q);
    const inCategory = !category || category === phoneCategory.slug;
    const byCondition = (p: Schemas['PostDto']) => {
      const wanted = filters.condition?.eq ?? filters.condition?.in;
      return !wanted || wanted.split(',').includes(String(p.fields.condition));
    };
    const priced = (p: Schemas['PostDto']) => {
      const price = poisha(p.price);
      return (
        (priceMin === null || (price !== null && price >= priceMin)) &&
        (priceMax === null || (price !== null && price < priceMax))
      );
    };
    const base = inCategory ? livePosts(tenantId).filter(textMatch) : [];
    const all = base.filter(byCondition).filter(priced);
    const conditionCounts = new Map<string, number>();
    for (const p of base.filter(priced)) {
      const c = String(p.fields.condition);
      conditionCounts.set(c, (conditionCounts.get(c) ?? 0) + 1);
    }
    const inRange = (lo: number, hi: number | null) =>
      base.filter(byCondition).filter((p) => {
        const price = poisha(p.price) ?? -1;
        return price >= lo && (hi === null || price < hi);
      }).length;
    const found: Schemas['SearchResponseDto'] = {
      query: url.searchParams.get('q') ?? '',
      searchId: q ? 'stub-search' : null,
      hits: all.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE).map(hitOf),
      landmarks: [],
      nextCursor: null,
      page,
      limit: SEARCH_PAGE_SIZE,
      totalHits: all.length,
      scope: area ? 'area' : 'area',
      radiusKm: 10,
      area: area ? { slug: STUB_AREA.slug, name: STUB_AREA.name } : null,
      facets: {
        categories: base.length > 0 ? [{ slug: phoneCategory.slug, count: base.length }] : [],
        price:
          base.length > 0
            ? {
                min: '10000.00',
                max: '30000.00',
                buckets: [
                  { min: '10000.00', max: '20000.00', count: inRange(1_000_000, 2_000_000) },
                  { min: '20000.00', max: null, count: inRange(2_000_000, null) },
                ],
              }
            : null,
        fields:
          category && conditionCounts.size > 0
            ? {
                condition: {
                  kind: 'values',
                  values: [...conditionCounts].map(([value, count]) => ({ value, count })),
                },
              }
            : {},
      },
      degraded: false,
    };
    send(res, 200, found);
    return true;
  }
  if (req.method === 'GET' && path === '/search/suggest') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const body: Schemas['SuggestResponseDto'] = {
      query: q,
      categories:
        q.length >= 2 && ('mobile phones মোবাইল ফোন'.includes(q) || q.startsWith('mob'))
          ? [{ slug: phoneCategory.slug, name: phoneCategory.name }]
          : [],
      queries: q.length >= 2 ? [{ query: `${q} dhaka` }] : [],
      listings: livePosts(tenantId)
        .filter((p) => q.length >= 2 && p.title.toLowerCase().includes(q))
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          tenantId: p.tenantId,
          title: { bn: p.title, en: null },
          categorySlug: phoneCategory.slug,
        })),
      degraded: false,
    };
    send(res, 200, body);
    return true;
  }
  if (req.method === 'GET' && path === '/seo/category-areas') {
    // Every stub post is a phone in the stub's one area.
    const count = livePosts(tenantId).length;
    const body: Schemas['CategoryAreasDto'] = {
      minListings: state.areaMinListings,
      items:
        count >= state.areaMinListings && tenantId === TENANT_MIRPUR
          ? [
              {
                category: { slug: phoneCategory.slug, name: phoneCategory.name },
                area: { slug: STUB_AREA.slug, name: STUB_AREA.name },
                count,
              },
            ]
          : [],
    };
    send(res, 200, body);
    return true;
  }
  if (req.method === 'GET' && path === '/feed') {
    const feed: Schemas['FeedResponseDto'] = {
      items: [
        {
          kind: 'bazar_prices',
          date: '2026-09-28',
          items: [
            {
              commodity: 'rice_coarse',
              name: { bn: 'মোটা চাল', en: 'Coarse rice' },
              unit: 'kg',
              minPrice: '52.00',
              maxPrice: '56.00',
            },
          ],
        },
        {
          kind: 'emergency',
          hotlines: [
            {
              serviceType: 'police',
              name: { bn: 'মিরপুর থানা', en: null },
              dial: '+8801320000000',
            },
          ],
        },
      ],
      nextCursor: null,
      scope: 'area',
      radiusKm: 6.5,
    };
    send(res, 200, feed);
    return true;
  }
  const actionMatch = /^\/posts\/([^/]+)\/(contact|view|og\.png)$/.exec(path);
  if (!actionMatch) return false;
  const post = state.posts.get(actionMatch[1] ?? '');
  if (req.method === 'GET' && actionMatch[2] === 'og.png') {
    if (!post || !isPublic(post)) fail(res, 404, 'OG_IMAGE_NOT_FOUND');
    else {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_1X1);
    }
    return true;
  }
  if (req.method !== 'POST') return false;
  if (actionMatch[2] === 'view') {
    send(res, 204);
    return true;
  }
  const body = await readJson(req);
  const channel = body?.channel;
  if (!post || post.status !== 'live') {
    fail(res, 404, 'POST_NOT_FOUND');
  } else if (
    (channel !== 'call' && channel !== 'sms' && channel !== 'whatsapp') ||
    !detailOf(post).contact.channels.includes(channel)
  ) {
    fail(res, 400, 'CONTACT_CHANNEL_UNAVAILABLE');
  } else {
    const phone = post.contact.phone ?? '';
    const reveal: Schemas['ContactRevealDto'] = {
      channel,
      name: post.contact.name,
      phone,
      href: channel === 'call' ? `tel:${phone}` : `sms:${phone}`,
      message: null,
    };
    send(res, 200, reveal);
  }
  return true;
}

function postFromBody(
  body: Record<string, unknown>,
  existing?: Schemas['PostDto'],
): Schemas['PostDto'] {
  const fields = (body.fields as Record<string, unknown> | undefined) ?? existing?.fields ?? {};
  const mediaIds =
    (body.mediaIds as string[] | undefined) ?? existing?.media.map((m) => m.id) ?? [];
  const phone =
    (body.contactPhone as string | undefined) ?? existing?.contact.phone ?? '+8801711111111';
  const showPhone = (body.showPhone as boolean | undefined) ?? existing?.showPhone ?? true;
  const showWhatsapp =
    (body.showWhatsapp as boolean | undefined) ?? existing?.showWhatsapp ?? false;
  return seedPost({
    ...(existing ?? {}),
    status: existing?.status ?? 'live',
    title: (body.title as string | undefined) ?? existing?.title ?? '',
    description: (body.description as string | null | undefined) ?? existing?.description ?? null,
    fields,
    price: typeof fields.price === 'string' ? fields.price : null,
    location:
      (body.location as { lat: number; lng: number } | undefined) ?? existing?.location ?? null,
    media: mediaIds.map((id) => ({
      id,
      thumbhash: null,
      thumbUrl: `${STUB_URL}/media/${id}.thumb.webp`,
      cardUrl: `${STUB_URL}/media/${id}.card.webp`,
      fullUrl: `${STUB_URL}/media/${id}.full.webp`,
    })),
    showPhone,
    allowChat: (body.allowChat as boolean | undefined) ?? existing?.allowChat ?? true,
    showWhatsapp,
    contact: {
      name: (body.contactName as string | undefined) ?? existing?.contact.name ?? null,
      phone: showPhone ? phone : null,
      whatsapp: showPhone && showWhatsapp,
    },
  });
}

// ---------------------------------------------------------------------------
// Tokens: unsigned JWT-shaped strings — the apps only read `exp`; this stub is
// the only thing that "verifies" them.
// ---------------------------------------------------------------------------

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function issueTokens(email: string): Schemas['SessionTokensDto'] {
  const persona = personas[email]!;
  const exp = Math.floor(Date.now() / 1000) + state.accessTtlSeconds;
  const accessToken = `${base64url({ alg: 'none' })}.${base64url({ sub: email, tenantId: persona.tenantId, exp })}.stub`;
  const refreshToken = randomUUID();
  state.refreshTokens.set(refreshToken, { email, used: false });
  return { accessToken, refreshToken };
}

function viewerOf(req: IncomingMessage): (Persona & { email: string }) | null {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(auth.slice(7).split('.')[1] ?? '', 'base64url').toString(),
    ) as {
      sub: string;
      tenantId: string;
      exp: number;
    };
    if (claims.exp * 1000 <= Date.now()) return null;
    if (claims.tenantId !== req.headers['x-tenant-id']) return null;
    const persona = personas[claims.sub];
    return persona ? { email: claims.sub, ...persona } : null;
  } catch {
    return null;
  }
}

const can = (viewer: Persona, module: string, action: string) =>
  viewer.isPlatformAdmin ||
  viewer.grants.some(
    (grant) =>
      (grant.module === '*' || grant.module === module) &&
      (grant.action === '*' || grant.action === action),
  );

// ---------------------------------------------------------------------------
// Base map (ADR 043): the API serves the .pmtiles archive, fonts and sprites
// as static files with range requests. The stub does the same from the
// z0–6 fixture build (fixtures/map, made by scripts/map/build-tiles.sh).
// ---------------------------------------------------------------------------

const MAP_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'map');
const MAP_MANIFEST = JSON.parse(readFileSync(join(MAP_FIXTURE_DIR, 'current.json'), 'utf8')) as {
  version: string;
  file: string;
  maxZoom: number;
  bbox: number[];
};

/** Map features around Mirpur: a cluster of posts, a post, a landmark and a 24h pharmacy. */
export const MAP_POST_ID = '0191e3a0-0000-7000-8000-00000000e001';
type MapFeatures = Schemas['MapFeaturesResponseDto'];
const ALL_LAYERS: MapFeatures['layers'] = ['posts', 'stores', 'places', 'landmarks', 'info'];
const NO_HOURS = new Set(['posts', 'stores']);
function mapPoint(
  layer: MapFeatures['layers'][number],
  id: string,
  lngLat: [number, number],
  more: Partial<Extract<MapFeatures['features'][number], { id: string }>['properties']>,
): MapFeatures['features'][number] {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: lngLat },
    properties: {
      cluster: false,
      layer,
      id,
      tenant_id: TENANT_MIRPUR,
      name_bn: null,
      name_en: null,
      category_slug: null,
      price: null,
      slug: null,
      info_kind: null,
      open_now: null,
      ...more,
    },
  };
}
function mapFeatures(layersParam: string | null, openNow: boolean): MapFeatures {
  const layers = layersParam
    ? ALL_LAYERS.filter((l) => layersParam.split(',').includes(l))
    : ALL_LAYERS;
  const features: MapFeatures['features'] = [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [90.37, 23.81] },
      properties: { cluster: true, layer: 'posts', count: 12, expansion_zoom: 14 },
    },
    mapPoint('posts', MAP_POST_ID, [90.3687, 23.8069], {
      name_bn: 'আইফোন ১৩, ১২৮ জিবি',
      price: '65000.00',
      category_slug: 'mobile-phones',
    }),
    mapPoint('landmarks', '0191e3a0-0000-7000-8000-00000000e002', [90.366, 23.805], {
      name_bn: 'মিরপুর স্টেডিয়াম',
      name_en: 'Mirpur Stadium',
      slug: 'mirpur-stadium',
      open_now: false,
    }),
    mapPoint('info', '0191e3a0-0000-7000-8000-00000000e003', [90.365, 23.808], {
      name_bn: 'মিরপুর ২৪ ঘণ্টা ফার্মেসি',
      name_en: 'Mirpur 24h Pharmacy',
      info_kind: 'pharmacy_24h',
      open_now: true,
    }),
  ];
  return {
    type: 'FeatureCollection',
    zoom: 13,
    layers,
    clustered: true,
    clipped: false,
    truncated: false,
    open_now_skipped: openNow ? layers.filter((l) => NO_HOURS.has(l)) : [],
    features: features.filter(
      (f) =>
        layers.includes(f.properties.layer) &&
        !(
          openNow &&
          (NO_HOURS.has(f.properties.layer) ||
            ('open_now' in f.properties && f.properties.open_now === false))
        ),
    ),
  };
}

function mapConfig(): Schemas['MapConfigDto'] {
  return {
    tiles: {
      url: `${STUB_URL}/tiles/${MAP_MANIFEST.file}`,
      version: MAP_MANIFEST.version,
      maxZoom: MAP_MANIFEST.maxZoom,
      bounds: MAP_MANIFEST.bbox,
    },
    assetsBaseUrl: `${STUB_URL}/tiles`,
    labelLanguage: 'en',
    fallbackStyleUrl: null,
  };
}

/** GET/HEAD /tiles/<path>, honouring a single `Range: bytes=a-b`, with CORS for the web apps. */
function serveTile(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const cors = {
    'access-control-allow-origin': String(req.headers.origin ?? '*'),
    'access-control-expose-headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
    vary: 'Origin',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'access-control-allow-headers': 'Range, If-Match' });
    res.end();
    return;
  }
  const relative = normalize(decodeURIComponent(pathname.slice('/tiles/'.length)));
  const file = join(MAP_FIXTURE_DIR, relative);
  if (relative.startsWith('..') || !file.startsWith(MAP_FIXTURE_DIR + sep) || !existsSync(file)) {
    state.mapMisses.push(relative);
    res.writeHead(404, cors);
    res.end();
    return;
  }
  const size = statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const type = file.endsWith('.json')
    ? 'application/json'
    : file.endsWith('.png')
      ? 'image/png'
      : file.endsWith('.ttf')
        ? 'font/ttf'
        : 'application/octet-stream';
  const headers = {
    ...cors,
    'content-type': type,
    'accept-ranges': 'bytes',
    etag: `"${MAP_MANIFEST.version}-${size}"`,
  };
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
  if (start >= size || end < start) {
    res.writeHead(416, { ...cors, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  state.mapRanges += 1;
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${size}`,
    'content-length': String(end - start + 1),
  });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file).subarray(start, end + 1));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/** The GlobalExceptionFilter's error body. */
function fail(res: ServerResponse, status: number, error: string): void {
  send(res, status, { statusCode: status, error, message: error });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['read', 'write', 'approve', 'delete', '*']);

function isGrantList(value: unknown): value is Grant[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (grant: unknown) =>
        typeof grant === 'object' &&
        grant !== null &&
        typeof (grant as Grant).module === 'string' &&
        ((grant as Grant).module === '*' || /^[a-z][a-z0-9_]*$/.test((grant as Grant).module)) &&
        ACTIONS.has((grant as Grant).action),
    )
  );
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'role'
  );
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://stub');

  if (url.pathname === '/__control' && req.method === 'POST') {
    const body = (await readJson(req)) ?? {};
    if (body.reset === true) state = freshState();
    if (typeof body.down === 'boolean') state.down = body.down;
    if (typeof body.accessTtlSeconds === 'number') state.accessTtlSeconds = body.accessTtlSeconds;
    if (typeof body.sitemapUrlsPerFile === 'number') {
      state.sitemapUrlsPerFile = body.sitemapUrlsPerFile;
    }
    if (typeof body.areaMinListings === 'number') state.areaMinListings = body.areaMinListings;
    if (typeof body.savedSearchLimit === 'boolean') state.savedSearchLimit = body.savedSearchLimit;
    if (Array.isArray(body.seedPosts)) {
      for (const post of body.seedPosts as Partial<Schemas['PostDto']>[]) seedPost(post);
    }
    return send(res, 200, {
      ok: true,
      posts: [...state.posts.values()].map((p) => ({ id: p.id, title: p.title })),
    });
  }
  if (url.pathname === '/__stats') {
    return send(res, 200, {
      hits: state.hits,
      posts: [...state.posts.values()],
      lastSearch: state.lastSearch,
      savedSearches: state.savedSearches,
      map: { ranges: state.mapRanges, misses: state.mapMisses, lastQuery: state.lastMapQuery },
      lastReversePurpose: state.lastReversePurpose,
    });
  }
  if (url.pathname.startsWith('/tiles/')) return serveTile(req, res, url.pathname);
  // The presigned upload target (what object storage is in a real deployment).
  const storageMatch = /^\/storage\/([^/]+)$/.exec(url.pathname);
  if (storageMatch && req.method === 'PUT') {
    const entry = state.media.get(storageMatch[1] ?? '');
    if (!entry) return fail(res, 404, 'NOT_FOUND');
    for await (const chunk of req) void chunk;
    entry.stored = true;
    return send(res, 200);
  }

  const hitKey = `${req.method ?? 'GET'} ${url.pathname.replace(/[0-9a-f-]{36}/gi, ':id')}`;
  state.hits[hitKey] = (state.hits[hitKey] ?? 0) + 1;

  if (state.down) return fail(res, 503, 'SERVICE_UNAVAILABLE');
  if (!url.pathname.startsWith(PREFIX)) return fail(res, 404, 'NOT_FOUND');
  const path = url.pathname.slice(PREFIX.length);
  const tenantId = String(req.headers['x-tenant-id'] ?? '');

  // --- base map (public, no tenant) ----------------------------------------
  if (req.method === 'GET' && path === '/map/config') return send(res, 200, mapConfig());
  if (req.method === 'GET' && path === '/map/features') {
    state.lastMapQuery = Object.fromEntries(url.searchParams);
    return send(
      res,
      200,
      mapFeatures(url.searchParams.get('layers'), url.searchParams.get('open_now') === 'true'),
    );
  }
  if (req.method === 'POST' && path === '/geo/route') {
    const asked = await readJson(req);
    const body: Schemas['GeoRouteResponseDto'] = {
      mode: asked?.mode === 'car' ? 'car' : 'foot',
      distanceMeters: 1971,
      durationSeconds: 1782,
      polyline: [
        [90.3687, 23.8069],
        [90.3695, 23.8075],
      ],
      source: 'barikoi',
      degraded: false,
    };
    return send(res, 200, body);
  }

  // --- tenants (public) ----------------------------------------------------
  if (req.method === 'GET' && path === '/tenants/resolve') {
    const host = (url.searchParams.get('host') ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (!host) return fail(res, 400, 'VALIDATION_FAILED');
    const slug = host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : null;
    const id = slug ? tenants.find((tenant) => tenant.slug === slug)?.id : customDomains[host];
    const body: Schemas['ResolvedHostDto'] = { tenantId: id ?? null };
    return send(res, 200, body);
  }
  if (req.method === 'GET' && path === '/tenants') return send(res, 200, tenants);
  if (req.method === 'GET' && path === '/tenant/config') {
    const tenant = tenants.find((candidate) => candidate.id === tenantId);
    if (!tenant) return fail(res, 400, 'TENANT_REQUIRED');
    return send(res, 200, tenantConfig(tenant));
  }

  // --- auth ----------------------------------------------------------------
  if (req.method === 'POST' && path === '/auth/email/login') {
    const body = await readJson(req);
    const device = body?.device as { platformCode?: unknown } | undefined;
    if (
      typeof body?.email !== 'string' ||
      typeof body.password !== 'string' ||
      device?.platformCode !== 'web'
    ) {
      return fail(res, 400, 'VALIDATION_FAILED');
    }
    const persona = personas[body.email];
    if (!persona || body.password !== PASSWORD || persona.tenantId !== tenantId) {
      return fail(res, 401, 'INVALID_CREDENTIALS');
    }
    return send(res, 200, issueTokens(body.email));
  }
  if (req.method === 'POST' && path === '/auth/refresh') {
    const body = await readJson(req);
    const entry = state.refreshTokens.get(String(body?.refreshToken));
    if (!entry) return fail(res, 401, 'REFRESH_TOKEN_INVALID');
    if (entry.used) return fail(res, 401, 'REFRESH_TOKEN_REUSED');
    entry.used = true;
    return send(res, 200, issueTokens(entry.email));
  }

  if (req.method === 'POST' && path === '/auth/otp/request') {
    const body = await readJson(req);
    if (typeof body?.phone !== 'string' || body.phone.replace(/^\+88/, '') !== SELLER_PHONE)
      return fail(res, 400, 'INVALID_PHONE');
    const sent: Schemas['OtpSentDto'] = { status: 'otp_sent', resendAfterSeconds: 60 };
    return send(res, 202, sent);
  }
  if (req.method === 'POST' && path === '/auth/otp/verify') {
    const body = await readJson(req);
    const device = body?.device as { platformCode?: unknown } | undefined;
    if (device?.platformCode !== 'web') return fail(res, 400, 'VALIDATION_FAILED');
    if (!tenantId) return fail(res, 400, 'TENANT_REQUIRED');
    if (body?.code !== OTP_CODE) return fail(res, 400, 'OTP_INCORRECT');
    return send(res, 200, issueTokens(PERSONAS.seller));
  }
  if (req.method === 'GET' && path === '/categories') return send(res, 200, [phoneCategory]);

  // Public (ADR 036): a share link and a post's detail need no session.
  const shareMatch = /^\/s\/([a-z0-9]+)$/.exec(path);
  if (req.method === 'GET' && shareMatch) {
    const post = [...state.posts.values()].find((p) => shortCodeOf(p.id) === shareMatch[1]);
    if (!post || post.status !== 'live') return fail(res, 404, 'SHORT_LINK_NOT_FOUND');
    const detail = detailOf(post);
    const tenant = tenants.find((t) => t.id === post.tenantId) ?? tenants[0]!;
    const link: Schemas['ShortLinkDto'] = {
      code: shareMatch[1]!,
      postId: post.id,
      tenantId: post.tenantId,
      tenantSlug: tenant.slug,
      url: detail.share!.url,
    };
    return send(res, 200, link);
  }
  const detailMatch = /^\/posts\/([^/]+)\/detail$/.exec(path);
  if (req.method === 'GET' && detailMatch) {
    const post = state.posts.get(detailMatch[1] ?? '');
    if (!post || (post.status !== 'live' && post.status !== 'sold')) {
      return fail(res, 404, 'POST_NOT_FOUND');
    }
    return send(res, 200, detailOf(post));
  }
  if (await handlePublic(req, res, url, path, tenantId)) return;
  const viewer = viewerOf(req);
  if (!viewer) return fail(res, 401, 'UNAUTHENTICATED');

  // --- geocoding, ownership --------------------------------------------------
  if (req.method === 'GET' && (path === '/geo/reverse' || path === '/posts/ownership')) {
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    if (path === '/posts/ownership') {
      // South of 23.7 is outside Mirpur in this stub.
      const outside = lat < 23.7;
      const ownership: Schemas['OwnershipDto'] = {
        tenantId: TENANT_MIRPUR,
        resolution: outside ? 'within_buffer' : 'inside_boundary',
        outsideBoundary: outside,
        needsReview: false,
      };
      return send(res, 200, ownership);
    }
    state.lastReversePurpose = url.searchParams.get('purpose');
    const reverse: Schemas['GeoReverseResponseDto'] = {
      location: { lat, lng },
      purpose: 'post_location',
      address: {
        label: 'Mirpur 10, Dhaka',
        labelBn: 'মিরপুর ১০, ঢাকা',
        area: 'Mirpur',
        city: 'Dhaka',
        postCode: '1216',
        source: 'barikoi',
      },
      areas: [],
      degraded: false,
    };
    return send(res, 200, reverse);
  }
  if (req.method === 'GET' && path === '/geo/autocomplete') {
    const found: Schemas['GeoAutocompleteResponseDto'] = {
      query: url.searchParams.get('q') ?? '',
      results: [
        {
          label: 'Section 10, Mirpur, Dhaka',
          labelBn: 'সেকশন ১০, মিরপুর, ঢাকা',
          location: { lat: 23.8086, lng: 90.3709 },
          area: 'Mirpur',
          city: 'Dhaka',
          postCode: '1216',
          source: 'barikoi',
          kind: 'address',
          refId: null,
          distanceMeters: null,
        },
      ],
      degraded: false,
    };
    return send(res, 200, found);
  }

  // --- media ---------------------------------------------------------------
  if (req.method === 'POST' && path === '/media/presign') {
    const body = await readJson(req);
    if (body?.kind !== 'image' || typeof body.checksumSha256 !== 'string')
      return fail(res, 400, 'VALIDATION_FAILED');
    const id = randomUUID();
    state.media.set(id, { stored: false });
    const presigned: Schemas['PresignedMediaDto'] = {
      id,
      storageKey: `media/${id}`,
      upload: {
        url: `${STUB_URL}/storage/${id}`,
        method: 'PUT',
        headers: { 'content-type': String(body.contentType) },
        expiresInSeconds: 600,
      },
    };
    return send(res, 201, presigned);
  }
  const mediaMatch = /^\/media\/([^/]+)(\/confirm)?$/.exec(path);
  if (mediaMatch) {
    const entry = state.media.get(mediaMatch[1] ?? '');
    if (!entry) return fail(res, 404, 'MEDIA_NOT_FOUND');
    if (mediaMatch[2] && !entry.stored) return fail(res, 409, 'UPLOAD_MISSING');
    // Confirm answers `processing`; the next look finds it ready (the worker).
    const status = mediaMatch[2] ? 'processing' : 'ready';
    const media: Schemas['MediaStatusDto'] = {
      id: mediaMatch[1] ?? '',
      status,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 1,
      width: null,
      height: null,
      thumbhash: null,
      variants: null,
    };
    return send(res, 200, media);
  }

  // --- posts ---------------------------------------------------------------
  if (req.method === 'POST' && path === '/posts') {
    const body = await readJson(req);
    const key = String(req.headers['idempotency-key'] ?? '');
    if (!key || body?.submit !== true) return fail(res, 400, 'VALIDATION_FAILED');
    const earlier = state.idempotency.get(key);
    if (earlier) return send(res, 200, state.posts.get(earlier));
    const phone = body.contactPhone;
    if (phone !== undefined && (typeof phone !== 'string' || !/^\+8801[3-9]\d{8}$/.test(phone))) {
      return send(res, 400, {
        statusCode: 400,
        error: 'VALIDATION_FAILED',
        message: 'x',
        details: [{ path: 'contactPhone', message: 'a BD mobile number' }],
      });
    }
    const post = postFromBody(body);
    state.idempotency.set(key, post.id);
    return send(res, 201, post);
  }
  if (req.method === 'GET' && path === '/posts/me/counts') {
    const counts: Schemas['MyPostCountsDto'] = {
      draft: 0,
      pending: 0,
      live: 0,
      rejected: 0,
      sold: 0,
      expired: 0,
      removed: 0,
      hidden: 0,
    };
    for (const post of state.posts.values()) {
      if (post.hiddenByOwner) counts.hidden++;
      else counts[post.status]++;
    }
    return send(res, 200, counts);
  }
  if (req.method === 'GET' && path === '/posts/me') {
    const statuses = url.searchParams.get('status')?.split(',') ?? null;
    const hidden = url.searchParams.get('hidden');
    const items = [...state.posts.values()]
      .filter((post) => !statuses || statuses.includes(post.status))
      .filter((post) => hidden === null || String(post.hiddenByOwner ?? false) === hidden)
      .reverse();
    const page: Schemas['MyPostsDto'] = { items, nextCursor: null };
    return send(res, 200, page);
  }
  const postMatch = /^\/posts\/([^/]+)(?:\/(sold|repost|hide|unhide|submit))?$/.exec(path);
  if (postMatch) {
    const post = state.posts.get(postMatch[1] ?? '');
    if (!post) return fail(res, 404, 'POST_NOT_FOUND');
    const action = postMatch[2];
    const touch = (change: Partial<Schemas['PostDto']>) => {
      const next = { ...post, ...change, updatedAt: new Date().toISOString() };
      state.posts.set(post.id, next);
      return send(res, 200, next);
    };
    if (req.method === 'GET' && !action) return send(res, 200, post);
    if (req.method === 'DELETE' && !action) {
      if (post.status === 'sold') return fail(res, 409, 'POST_NOT_EDITABLE');
      state.posts.delete(post.id);
      state.gone.add(post.id);
      return send(res, 204);
    }
    if (req.method === 'PATCH' && !action) {
      // Same id: postFromBody keeps the existing post's fields it isn't given.
      return send(res, 200, postFromBody((await readJson(req)) ?? {}, post));
    }
    if (req.method === 'POST') {
      const body = (await readJson(req)) ?? {};
      switch (action) {
        case 'sold':
          if (post.status !== 'live') return fail(res, 409, 'POST_ILLEGAL_TRANSITION');
          return touch({
            status: 'sold',
            isSold: true,
            soldPrice: (body.soldPrice as string | undefined) ?? null,
          });
        case 'repost':
          if (post.status === 'live') {
            return send(res, 409, {
              statusCode: 409,
              error: 'POST_RENEW_TOO_EARLY',
              message: 'x',
              details: { renewableFrom: '2026-10-17T00:00:00.000Z' },
            });
          }
          return touch({ status: 'live' });
        case 'hide':
          return touch({ hiddenByOwner: true });
        case 'unhide':
          return touch({ hiddenByOwner: false });
        case 'submit':
          return touch({ status: 'pending', moderationReason: null, moderationNote: null });
      }
    }
  }

  if (req.method === 'POST' && path === '/saved-searches') {
    const body = (await readJson(req)) as Schemas['CreateSavedSearchDto'];
    if (state.savedSearchLimit) {
      return send(res, 409, {
        statusCode: 409,
        error: 'SAVED_SEARCH_LIMIT_REACHED',
        message: 'x',
        details: { maxActive: 5 },
      });
    }
    state.savedSearches.push(body);
    const saved: Schemas['SavedSearchDto'] = {
      id: randomUUID(),
      name: body.name,
      q: body.q ?? '',
      filters: {
        category: body.filters?.category ?? null,
        fields: body.filters?.fields ?? {},
        priceMin: body.filters?.price_min ?? null,
        priceMax: body.filters?.price_max ?? null,
      },
      center: body.center,
      radiusKm: body.radius_km,
      frequency: body.frequency ?? 'daily',
      active: true,
      pausedAt: null,
      newResultCount: 0,
      lastAlertedAt: null,
      createdAt: new Date().toISOString(),
    };
    return send(res, 201, saved);
  }
  if (req.method === 'POST' && path === '/auth/logout') {
    const body = await readJson(req);
    state.refreshTokens.delete(String(body?.refreshToken));
    const loggedOut: Schemas['LoggedOutDto'] = { status: 'logged_out' };
    return send(res, 200, loggedOut);
  }
  if (req.method === 'GET' && path === '/auth/me') {
    const me: Schemas['MeResultDto'] = {
      userId: viewer.userId,
      phone: '+8801711111111',
      email: viewer.email,
      displayName: viewer.displayName,
      avatarStorageKey: null,
      tenantId: viewer.tenantId,
      memberId: randomUUID(),
      role: viewer.role,
    };
    return send(res, 200, me);
  }
  if (req.method === 'GET' && path === '/me/permissions') {
    const permissions: Schemas['MyPermissionsDto'] = {
      isPlatformAdmin: viewer.isPlatformAdmin,
      grants: viewer.grants,
      role: viewer.role,
    };
    return send(res, 200, permissions);
  }

  // --- roles ---------------------------------------------------------------
  const customs = state.customRoles.get(tenantId) ?? [];
  if (req.method === 'GET' && path === '/roles') {
    if (!can(viewer, 'roles', 'read')) return fail(res, 403, 'PERMISSION_DENIED');
    return send(res, 200, [...builtinRoles, ...customs]);
  }
  if (req.method === 'POST' && path === '/roles') {
    if (!can(viewer, 'roles', 'write')) return fail(res, 403, 'PERMISSION_DENIED');
    const body = await readJson(req);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || !isGrantList(body?.permissions)) return fail(res, 400, 'VALIDATION_FAILED');
    const code = slugify(name);
    if (customs.some((role) => role.code === code)) return fail(res, 409, 'ROLE_ALREADY_EXISTS');
    const role: Role = {
      id: randomUUID(),
      code,
      name,
      isBuiltin: false,
      permissions: body.permissions,
    };
    customs.push(role);
    return send(res, 201, role);
  }
  const roleMatch = /^\/roles\/([^/]+)$/.exec(path);
  if (roleMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const id = roleMatch[1] ?? '';
    if (!can(viewer, 'roles', req.method === 'PATCH' ? 'write' : 'delete')) {
      return fail(res, 403, 'PERMISSION_DENIED');
    }
    if (!UUID.test(id)) return fail(res, 400, 'VALIDATION_FAILED');
    if (builtinRoles.some((role) => role.id === id))
      return fail(res, 409, 'ROLE_BUILTIN_IMMUTABLE');
    const role = customs.find((candidate) => candidate.id === id);
    if (!role) return fail(res, 404, 'ROLE_NOT_FOUND');

    if (req.method === 'DELETE') {
      customs.splice(customs.indexOf(role), 1);
      return send(res, 204);
    }
    const body = (await readJson(req)) ?? {};
    if (body.name === undefined && body.permissions === undefined)
      return fail(res, 400, 'VALIDATION_FAILED');
    if (body.permissions !== undefined && !isGrantList(body.permissions)) {
      return fail(res, 400, 'VALIDATION_FAILED');
    }
    if (typeof body.name === 'string') role.name = body.name.trim();
    if (isGrantList(body.permissions)) role.permissions = body.permissions;
    return send(res, 200, role);
  }

  return fail(res, 404, 'NOT_FOUND');
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error);
    fail(res, 500, 'INTERNAL_SERVER_ERROR');
  });
}).listen(STUB_PORT, '127.0.0.1', () => {
  console.log(`stub api listening on http://127.0.0.1:${STUB_PORT}`);
});

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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { components } from '@amar-elaka/shared-types';
import {
  OTP_CODE,
  PASSWORD,
  PERSONAS,
  PHONE_CATEGORY_ID,
  SELLER_PHONE,
  STUB_PORT,
  STUB_URL,
  TENANT_MIRPUR,
  TENANT_SAVAR,
} from './fixtures';

type Schemas = components['schemas'];
type Role = Schemas['RoleDto'];
type Grant = Role['permissions'][number];

const PREFIX = '/api/v1';

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
    if (Array.isArray(body.seedPosts)) {
      for (const post of body.seedPosts as Partial<Schemas['PostDto']>[]) seedPost(post);
    }
    return send(res, 200, {
      ok: true,
      posts: [...state.posts.values()].map((p) => ({ id: p.id, title: p.title })),
    });
  }
  if (url.pathname === '/__stats') {
    return send(res, 200, { hits: state.hits, posts: [...state.posts.values()] });
  }
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

  const viewer = viewerOf(req);
  if (!viewer) return fail(res, 401, 'UNAUTHENTICATED');

  // --- geocoding, ownership --------------------------------------------------
  if (req.method === 'GET' && (path === '/geocode/reverse' || path === '/posts/ownership')) {
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
    const reverse: Schemas['ReverseGeocodeResponseDto'] = {
      location: { lat, lng },
      address: {
        label: 'Mirpur 10, Dhaka',
        labelBn: 'মিরপুর ১০, ঢাকা',
        location: { lat, lng },
        area: 'Mirpur',
        city: 'Dhaka',
        postCode: '1216',
        source: 'provider',
        distanceMeters: null,
      },
      areas: [],
      degraded: false,
    };
    return send(res, 200, reverse);
  }
  if (req.method === 'GET' && path === '/geocode/autocomplete') {
    const found: Schemas['GeocodeResponseDto'] = {
      query: url.searchParams.get('q') ?? '',
      results: [
        {
          label: 'Section 10, Mirpur, Dhaka',
          labelBn: 'সেকশন ১০, মিরপুর, ঢাকা',
          location: { lat: 23.8086, lng: 90.3709 },
          area: 'Mirpur',
          city: 'Dhaka',
          postCode: '1216',
          source: 'provider',
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

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
import { PASSWORD, PERSONAS, STUB_PORT, TENANT_MIRPUR, TENANT_SAVAR } from './fixtures';

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
  };
}
let state = freshState();

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
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__stats') return send(res, 200, { hits: state.hits });

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

  const viewer = viewerOf(req);
  if (!viewer) return fail(res, 401, 'UNAUTHENTICATED');

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

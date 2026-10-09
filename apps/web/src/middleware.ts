import { NextResponse, type NextRequest } from 'next/server';
import { isAccessTokenExpired } from '@/lib/auth/jwt';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_MAX_AGE,
  REFRESH_TOKEN_COOKIE,
} from '@/lib/auth/session';
import { publicPageGate } from '@/lib/seo/public-gate';
import {
  TENANT_ID_HEADER,
  TENANT_RESOLUTION_HEADER,
  type TenantResolution,
} from '@/lib/tenant-headers';

const RESOLVE_TIMEOUT_MS = 3_000;
const REFRESH_TIMEOUT_MS = 5_000;

/** Seller pages: a session is required (post creation, my posts). */
const PROTECTED_PREFIXES = ['/post', '/me', '/seller'];
const LOGIN_PATH = '/login';
// Infrastructure tuning, not business rules: how long a hostname's answer is
// reused before asking again, and how many hostnames are remembered at once.
// The API caches the lookup itself (TENANT_CACHE_TTL_MS); this only saves the
// round trip on every page view.
const RESOLVE_CACHE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX_ENTRIES = 1_000;

// Module state survives across requests in a long-running `next start`
// process. Only definite answers are kept — never 'unavailable', which must be
// retried on the next request.
const resolved = new Map<string, { resolution: TenantResolution; expiresAt: number }>();

/**
 * Resolves which tenant a hostname belongs to and hands the answer downstream
 * as `x-tenant-id`, plus `x-tenant-resolution` saying how it went.
 *
 * The API resolves tenants from its own `Host` header, but this is a separate
 * server: a server-side fetch from here carries the API's hostname, not the
 * browser's, so the browser's hostname has to be resolved explicitly and
 * forwarded as the header the API checks first. `GET /tenants/resolve` applies
 * exactly the same subdomain/custom-domain precedence the API's own middleware
 * uses (apps/api/src/database/hostname-tenant-signal.ts).
 *
 * "No tenant at this host" and "could not ask" are different answers and are
 * kept apart: the first renders the no-coverage page, the second the error
 * page with a retry — telling a visitor their area does not exist because the
 * API blipped would be wrong.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const host = request.headers.get('host');
  const resolution: TenantResolution = host ? await resolveCached(host) : { kind: 'none' };

  const headers = new Headers(request.headers);
  // Never let a client-supplied value through: these headers are what the API
  // and the pages trust, so they may only ever carry what was resolved here.
  headers.delete(TENANT_ID_HEADER);
  headers.set(TENANT_RESOLUTION_HEADER, resolution.kind);
  if (resolution.kind === 'resolved') headers.set(TENANT_ID_HEADER, resolution.tenantId);
  // Where the visitor was going, for a login redirect's `next`.
  headers.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search);

  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (isProtected) return gate(request, headers, resolution);

  // Listing, category and store URLs: 410 / 404 / canonical redirects (ADR 039).
  const answer = await publicPageGate(
    request,
    headers,
    resolution.kind === 'resolved' ? resolution.tenantId : null,
  );
  return answer ?? NextResponse.next({ request: { headers } });
}

/**
 * A UX gate, not the security boundary (the API checks the token on every
 * call): lets a live session through, rotates an expired access token on the
 * way (so a seller isn't sent to login every fifteen minutes), and sends
 * anyone else to /login with `next` set to come back here.
 */
async function gate(
  request: NextRequest,
  headers: Headers,
  resolution: TenantResolution,
): Promise<NextResponse> {
  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (accessToken && !isAccessTokenExpired(accessToken)) {
    return NextResponse.next({ request: { headers } });
  }

  if (refreshToken && resolution.kind === 'resolved') {
    const rotation = await rotate(refreshToken, resolution.tenantId);
    if (rotation.kind === 'rotated') {
      // The page renders in this same request: hand it the new tokens too.
      headers.set(
        'cookie',
        [
          `${ACCESS_TOKEN_COOKIE}=${rotation.accessToken}`,
          `${REFRESH_TOKEN_COOKIE}=${rotation.refreshToken}`,
        ].join('; '),
      );
      const response = NextResponse.next({ request: { headers } });
      const options = {
        httpOnly: true as const,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
      };
      response.cookies.set(ACCESS_TOKEN_COOKIE, rotation.accessToken, options);
      response.cookies.set(REFRESH_TOKEN_COOKIE, rotation.refreshToken, {
        ...options,
        maxAge: REFRESH_COOKIE_MAX_AGE,
      });
      return response;
    }
    // The API couldn't be asked: keep the (still unspent) session and let the
    // page report the outage, rather than logging the seller out over a blip.
    if (rotation.kind === 'unavailable') return NextResponse.next({ request: { headers } });
  }

  const login = new URL(LOGIN_PATH, request.url);
  login.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  const redirect = NextResponse.redirect(login);
  redirect.cookies.delete(ACCESS_TOKEN_COOKIE);
  redirect.cookies.delete(REFRESH_TOKEN_COOKIE);
  return redirect;
}

type Rotation =
  | { kind: 'rotated'; accessToken: string; refreshToken: string }
  /** The API answered no: expired, revoked, or a replay of a spent token. */
  | { kind: 'refused' }
  /** The API could not answer: down, timed out, or a 5xx. */
  | { kind: 'unavailable' };

async function rotate(refreshToken: string, tenantId: string): Promise<Rotation> {
  try {
    const response = await fetch(`${process.env.API_BASE_URL ?? ''}/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [TENANT_ID_HEADER]: tenantId,
      },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (response.status >= 500) return { kind: 'unavailable' };
    if (!response.ok) return { kind: 'refused' };
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return { kind: 'refused' };
    const { accessToken, refreshToken: next } = body as Record<string, unknown>;
    return typeof accessToken === 'string' && typeof next === 'string'
      ? { kind: 'rotated', accessToken, refreshToken: next }
      : { kind: 'refused' };
  } catch {
    return { kind: 'unavailable' };
  }
}

async function resolveCached(host: string): Promise<TenantResolution> {
  const key = host.toLowerCase();
  const hit = resolved.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.resolution;

  // One retry when the API couldn't answer (timeout, network, 5xx), like
  // apiFetch (CLAUDE.md rule 5); a definite answer is never retried.
  let resolution = await resolve(key);
  if (resolution.kind === 'unavailable') resolution = await resolve(key);
  if (resolution.kind !== 'unavailable') {
    // Bounded, because the Host header is client-controlled: evict the oldest
    // entry (Map preserves insertion order) rather than grow without limit.
    if (resolved.size >= RESOLVE_CACHE_MAX_ENTRIES) {
      const oldest = resolved.keys().next().value;
      if (oldest !== undefined) resolved.delete(oldest);
    }
    resolved.set(key, { resolution, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
  }
  return resolution;
}

async function resolve(host: string): Promise<TenantResolution> {
  const url = new URL(`${process.env.API_BASE_URL ?? ''}/tenants/resolve`);
  url.searchParams.set('host', host);

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    // A 4xx is the API refusing this host (e.g. malformed) — an answer.
    // A 5xx means it could not answer.
    if (!response.ok) return response.status >= 500 ? { kind: 'unavailable' } : { kind: 'none' };

    const body: unknown = await response.json();
    const tenantId =
      typeof body === 'object' && body !== null ? (body as { tenantId?: unknown }).tenantId : null;
    return typeof tenantId === 'string' ? { kind: 'resolved', tenantId } : { kind: 'none' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export const config = {
  // The sitemap is per-tenant, so it must be resolved like any page; robots.txt
  // only needs the host and is left out.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};

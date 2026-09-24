import { NextResponse, type NextRequest } from 'next/server';
import {
  TENANT_ID_HEADER,
  TENANT_RESOLUTION_HEADER,
  type TenantResolution,
} from '@/lib/tenant-headers';

const RESOLVE_TIMEOUT_MS = 3_000;
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

  return NextResponse.next({ request: { headers } });
}

async function resolveCached(host: string): Promise<TenantResolution> {
  const key = host.toLowerCase();
  const hit = resolved.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.resolution;

  const resolution = await resolve(key);
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

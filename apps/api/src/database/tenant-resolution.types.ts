import type { FastifyRequest } from 'fastify';

export interface ResolvedTenant {
  id: string;
  slug: string;
  customDomain: string | null;
  statusCode: string;
}

/**
 * What TenantResolutionMiddleware found, for TenantGateGuard to act on.
 * The middleware never rejects a request itself — it doesn't know which
 * routes are allowlisted (`@AllowAnyTenant()`) — so this carries enough
 * detail for the guard to pick the right error.
 */
export type TenantResolutionOutcome =
  | { kind: 'resolved'; tenant: ResolvedTenant }
  /** X-Tenant-Id was present but not a valid id — never falls through to subdomain/domain. */
  | { kind: 'invalid_id' }
  /** A specific signal was found (id, subdomain, or domain) but matched no active tenant. */
  | { kind: 'not_found' }
  /** No X-Tenant-Id, no matching subdomain, no matching custom domain. */
  | { kind: 'none' };

// Nest's Fastify adapter hands middleware the raw Node request, not the
// FastifyRequest that guards and controllers get — so the outcome lives on
// the raw request, and readers must go through tenantResolutionOf().
declare module 'http' {
  interface IncomingMessage {
    tenantResolution?: TenantResolutionOutcome;
  }
}

/** What TenantResolutionMiddleware stored for this request, if it ran. */
export function tenantResolutionOf(request: FastifyRequest): TenantResolutionOutcome | undefined {
  return request.raw.tenantResolution;
}

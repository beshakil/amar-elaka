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

declare module 'fastify' {
  interface FastifyRequest {
    tenantResolution?: TenantResolutionOutcome;
  }
}

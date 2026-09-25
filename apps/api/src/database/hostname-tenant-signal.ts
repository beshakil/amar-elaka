// Mirrors the slug CHECK constraint (infra/migrations/0001_tenancy_identity.sql).
const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

/**
 * What a Host header points at, before any lookup happens. Shared by
 * TenantResolutionMiddleware (its own pipeline) and TenantsService.resolveByHost
 * (the endpoint an edge/BFF caller uses to resolve a browser's hostname it
 * can't forward) so both read a hostname exactly the same way.
 */
export type HostnameTenantSignal =
  | { kind: 'slug'; slug: string }
  | { kind: 'custom_domain'; domain: string }
  /** A *.rootDomain host whose label is not a clean single slug — never someone else's custom domain. */
  | { kind: 'unusable' }
  | { kind: 'absent' };

export function rootDomainSuffixOf(rootDomain: string): string {
  return `.${rootDomain.toLowerCase()}`;
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  // An IPv6 literal ("[::1]:3000") is never a tenant host; splitting it on ':' would garble it.
  if (host.startsWith('[')) return undefined;
  return host.split(':')[0]?.toLowerCase();
}

export function tenantSignalFromHostname(
  host: string | undefined,
  rootDomainSuffix: string,
): HostnameTenantSignal {
  const hostname = hostnameOf(host);
  if (!hostname) return { kind: 'absent' };

  if (hostname.endsWith(rootDomainSuffix)) {
    const label = hostname.slice(0, -rootDomainSuffix.length);
    if (!SLUG_PATTERN.test(label)) return { kind: 'unusable' };
    return { kind: 'slug', slug: label };
  }

  // Hosts that can never be anyone's custom domain carry no tenant signal:
  // single-label names (localhost, a docker service like `api`) and IP
  // literals. The request is then treated as having no tenant (400
  // TENANT_REQUIRED on tenant routes), not as an unknown domain (404).
  if (!hostname.includes('.') || IPV4_LITERAL.test(hostname)) return { kind: 'absent' };

  return { kind: 'custom_domain', domain: hostname };
}

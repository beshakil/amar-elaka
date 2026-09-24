import { cache } from 'react';
import { headers } from 'next/headers';
import { z } from 'zod';
import { apiFetch, ApiUnreachableError } from './api/fetch';
import { tenantConfigSchema, tenantSummarySchema, type TenantConfig } from './api/schemas';
import { env } from './env';
import { TENANT_ID_HEADER, TENANT_RESOLUTION_HEADER } from './tenant-headers';

// How long a tenant's config and the area directory stay in Next's data cache.
// Infrastructure tuning that mirrors the API's own TENANT_CACHE_TTL_MS intent,
// not a business rule.
const TENANT_CACHE_SECONDS = 300;

/**
 * The tenant `middleware.ts` resolved for this request, or null when the
 * hostname has none. Throws when resolution itself failed, so a page shows the
 * error state rather than claiming the area does not exist.
 */
export const currentTenantId = cache(async (): Promise<string | null> => {
  const requestHeaders = await headers();
  if (requestHeaders.get(TENANT_RESOLUTION_HEADER) === 'unavailable') {
    throw new ApiUnreachableError();
  }
  return requestHeaders.get(TENANT_ID_HEADER);
});

/**
 * For page bodies: null means "no tenant here" (render the no-coverage page);
 * an unreachable API throws into the route's error boundary.
 */
export const currentTenantConfig = cache(async (): Promise<TenantConfig | null> => {
  const tenantId = await currentTenantId();
  if (!tenantId) return null;
  return apiFetch({
    path: '/tenant/config',
    schema: tenantConfigSchema,
    tenantId,
    revalidate: TENANT_CACHE_SECONDS,
  });
});

/**
 * For the chrome around a page — layout, header, footer, metadata. These must
 * never take the page down with them: if the tenant cannot be loaded they
 * render the platform defaults, and the page body reports the failure.
 */
export const tenantConfigForChrome = cache(async (): Promise<TenantConfig | null> =>
  currentTenantConfig().catch(() => null),
);

/**
 * The origin this request was served on — the tenant's own subdomain or custom
 * domain, not the platform's. Canonical URLs, the sitemap and JSON-LD must all
 * name the tenant's host, or every tenant would declare the same canonical site.
 * The host is trustworthy here because only a hostname the API resolved to a
 * tenant reaches a page that uses it; the scheme comes from configuration,
 * since behind the proxy this server only ever sees plain HTTP.
 */
export const currentOrigin = cache(async (): Promise<string> => {
  const host = (await headers()).get('host');
  if (!host) return env().SITE_ORIGIN;
  return `${new URL(env().SITE_ORIGIN).protocol}//${host}`;
});

/** The public area directory, for the "change area" switcher. */
export const listTenants = cache(async () =>
  apiFetch({
    path: '/tenants',
    schema: z.array(tenantSummarySchema),
    revalidate: TENANT_CACHE_SECONDS,
  }),
);

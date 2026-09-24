import type { MetadataRoute } from 'next';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

/**
 * Per-tenant: this runs on a request to `<tenant>.<root domain>/sitemap.xml`,
 * so the tenant middleware resolved is the one it describes, and every URL is
 * on that tenant's own host. Only the fixed
 * routes are listed — listings and stores are enumerated here once those
 * endpoints exist rather than being invented now.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Throws if the API is unreachable: a failed sitemap is retried by the
  // crawler, whereas an empty one would tell it the site has no pages.
  const tenant = await currentTenantConfig();
  if (!tenant) return [];
  const origin = await currentOrigin();

  const lastModified = new Date();
  const entries: MetadataRoute.Sitemap = [
    { url: new URL('/', origin).toString(), lastModified, priority: 1 },
    { url: new URL('/map', origin).toString(), lastModified, priority: 0.5 },
    { url: new URL('/info', origin).toString(), lastModified, priority: 0.5 },
    { url: new URL('/areas', origin).toString(), lastModified, priority: 0.3 },
  ];

  for (const category of tenant.enabledCategories) {
    entries.push({
      url: new URL(`/category/${category.slug}`, origin).toString(),
      lastModified,
      priority: 0.7,
    });
  }

  return entries;
}

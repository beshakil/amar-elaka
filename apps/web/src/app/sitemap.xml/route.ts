import { indexXml, sitemapFiles } from '@/lib/seo/sitemap';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

/**
 * The tenant's sitemap index (ADR 039), on its own host. Throws when the API
 * is unreachable: a failed sitemap is retried by the crawler, an empty one
 * would say the site has no pages.
 */
export async function GET(): Promise<Response> {
  const tenant = await currentTenantConfig();
  if (!tenant) return new Response(null, { status: 404 });
  const xml = indexXml(await currentOrigin(), await sitemapFiles(tenant));
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

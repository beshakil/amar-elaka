import { sitemapUrls, urlsetXml } from '@/lib/seo/sitemap';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

/** One sitemap file: pages.xml, listings-<n>.xml or stores-<n>.xml (ADR 039). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant || !file.endsWith('.xml')) return new Response(null, { status: 404 });
  const urls = await sitemapUrls(tenant, await currentOrigin(), file.slice(0, -'.xml'.length));
  if (!urls) return new Response(null, { status: 404 });
  return new Response(urlsetXml(urls), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

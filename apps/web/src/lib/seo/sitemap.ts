import { apiFetch } from '../api/fetch';
import {
  categoryAreasSchema,
  sitemapPostsSchema,
  sitemapStoresSchema,
  sitemapSummarySchema,
  type TenantConfig,
} from '../api/schemas';
import { listingPath } from './slug';

/**
 * Per-tenant sitemaps (ADR 039): /sitemap.xml is an index of
 *   /sitemaps/pages.xml         home, info pages, categories, category + area
 *                               landing pages (ADR 042)
 *   /sitemaps/listings-<n>.xml  live listings (and sold ones still indexed)
 *   /sitemaps/stores-<n>.xml    active stores
 * each at most sitemap_urls_per_file URLs (setting), so a big area splits
 * into several files instead of one past the protocol's limit.
 */

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

/** The counts and the per-file size: the index and every file split by the same number. */
const summaryOf = (tenant: TenantConfig) =>
  apiFetch({ path: '/seo/sitemap/summary', schema: sitemapSummarySchema, tenantId: tenant.id });

export async function sitemapFiles(tenant: TenantConfig): Promise<string[]> {
  const summary = await summaryOf(tenant);
  const size = summary.urlsPerFile;
  const count = (n: number) => Math.max(1, Math.ceil(n / size));
  return [
    'pages',
    ...Array.from({ length: count(summary.posts) }, (_, i) => `listings-${i}`),
    ...(summary.stores > 0
      ? Array.from({ length: count(summary.stores) }, (_, i) => `stores-${i}`)
      : []),
  ];
}

export async function sitemapUrls(
  tenant: TenantConfig,
  origin: string,
  file: string,
): Promise<SitemapUrl[] | null> {
  const url = (path: string) => new URL(path, origin).toString();
  if (file === 'pages') {
    // The landing pages that exist now; if they can't be listed, the rest of
    // the file still goes out (they return on the next crawl).
    const areas = await apiFetch({
      path: '/seo/category-areas',
      schema: categoryAreasSchema,
      tenantId: tenant.id,
    })
      .then((pairs) => pairs.items)
      .catch(() => []);
    return [
      { loc: url('/') },
      { loc: url('/info') },
      { loc: url('/map') },
      ...tenant.enabledCategories.map((c) => ({ loc: url(`/category/${c.slug}`) })),
      ...areas.map((i) => ({ loc: url(`/category/${i.category.slug}/${i.area.slug}`) })),
    ];
  }
  const match = /^(listings|stores)-(\d+)$/.exec(file);
  if (!match) return null;
  const index = Number(match[2]);
  const size = (await summaryOf(tenant)).urlsPerFile;
  const query = { offset: String(index * size), limit: String(size) };
  if (match[1] === 'listings') {
    const page = await apiFetch({
      path: '/seo/sitemap/posts',
      schema: sitemapPostsSchema,
      tenantId: tenant.id,
      query,
    });
    return page.items.map((item) => ({
      loc: url(listingPath(item.id, item.title)),
      lastmod: item.updatedAt,
    }));
  }
  const page = await apiFetch({
    path: '/seo/sitemap/stores',
    schema: sitemapStoresSchema,
    tenantId: tenant.id,
    query,
  });
  return page.items.map((item) => ({ loc: url(`/store/${item.slug}`), lastmod: item.updatedAt }));
}

const escapeXml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export function urlsetXml(urls: SitemapUrl[]): string {
  const body = urls
    .map(
      (u) =>
        `<url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : ''}</url>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

export function indexXml(origin: string, files: string[]): string {
  const body = files
    .map(
      (file) =>
        `<sitemap><loc>${escapeXml(new URL(`/sitemaps/${file}.xml`, origin).toString())}</loc></sitemap>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>`;
}

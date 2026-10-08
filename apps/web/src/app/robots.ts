import type { MetadataRoute } from 'next';
import { currentOrigin } from '@/lib/tenant';

/** Served per host, so each tenant points crawlers at its own sitemap index. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Seller pages, sign-in and this site's own endpoints aren't content.
      disallow: ['/api/', '/me/', '/post/', '/login', '/gone', '/store/*/catalog/order/'],
    },
    sitemap: new URL('/sitemap.xml', await currentOrigin()).toString(),
  };
}

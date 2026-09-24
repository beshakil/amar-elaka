import type { MetadataRoute } from 'next';
import { currentOrigin } from '@/lib/tenant';

/** Served per host, so each tenant points crawlers at its own sitemap. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Placeholder detail routes carry `robots: { index: false }` of their own;
      // this keeps crawlers off them at the host level too until they serve
      // real content.
      disallow: ['/listing/', '/store/'],
    },
    sitemap: new URL('/sitemap.xml', await currentOrigin()).toString(),
  };
}

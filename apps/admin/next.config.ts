import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Deployed as a container image (Coolify/Docker), not on a serverless platform.
  output: 'standalone',
  typedRoutes: true,
  // Workspace packages shipped as TypeScript source (packages/dynamic-form,
  // and packages/map-style's base map styles for the heatmap page).
  transpilePackages: ['@amar-elaka/dynamic-form', '@amar-elaka/ui', '@amar-elaka/map-style'],
  // Dashboards are behind a login and must never be indexed.
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ]),
};

export default withNextIntl(nextConfig);

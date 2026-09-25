import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Deployed as a container image (Coolify/Docker), not on a serverless platform.
  output: 'standalone',
  typedRoutes: true,
  // Workspace package shipped as TypeScript source (packages/dynamic-form).
  transpilePackages: ['@amar-elaka/dynamic-form'],
};

export default withNextIntl(nextConfig);

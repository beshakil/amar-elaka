import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Deployed as a container image (Coolify/Docker), not on a serverless platform.
  output: 'standalone',
  typedRoutes: true,
  // Metadata (title, description, canonical, robots) always in <head>, never
  // streamed in after it: crawlers and link previews all read the head
  // (ADR 039). Our pages' metadata is a few cached reads, so blocking is cheap.
  htmlLimitedBots: /.*/,
  experimental: {
    // `radix-ui` is a barrel of every primitive; without this, importing
    // just Slot (components/ui/button) put all of them in every page's JS.
    optimizePackageImports: ['radix-ui'],
  },
  // Workspace packages shipped as TypeScript source (packages/dynamic-form,
  // packages/shared-types, and packages/map-style's base map styles).
  transpilePackages: [
    '@amar-elaka/dynamic-form',
    '@amar-elaka/shared-types',
    '@amar-elaka/map-style',
  ],
};

export default withNextIntl(nextConfig);

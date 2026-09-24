import type { TenantConfig } from '../api/schemas';
import { storageUrl } from '../env';

/**
 * Typed builders for the JSON-LD blocks this site emits. They exist as plain
 * functions (not components) so a page can compose several and render them in
 * one script tag, and so the shapes stay testable without rendering.
 *
 * `origin` is the tenant's own origin (`currentOrigin()`), never the platform's:
 * structured data must describe the site the crawler is actually on.
 */

interface JsonLd {
  '@context': 'https://schema.org';
  '@type': string;
  [key: string]: unknown;
}

export function organizationJsonLd(tenant: TenantConfig, origin: string): JsonLd {
  const logoKey = tenant.branding.logoStorageKey;
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: tenant.nameBn,
    alternateName: tenant.nameEn,
    url: origin,
    ...(logoKey ? { logo: storageUrl(logoKey) } : {}),
    ...(tenant.support.email ? { email: tenant.support.email } : {}),
    ...(tenant.support.phoneE164 ? { telephone: tenant.support.phoneE164 } : {}),
  };
}

export function webSiteJsonLd(tenant: TenantConfig, origin: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: tenant.nameBn,
    url: origin,
    inLanguage: tenant.defaultLocale,
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[], origin: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: new URL(item.path, origin).toString(),
    })),
  };
}

/** Escapes `</script` so a value can never break out of the script tag. */
export function jsonLdScript(...blocks: JsonLd[]): string {
  return JSON.stringify(blocks.length === 1 ? blocks[0] : blocks).replaceAll('<', '\\u003c');
}

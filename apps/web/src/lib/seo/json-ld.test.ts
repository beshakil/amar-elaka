import { describe, expect, it } from 'vitest';
import type { TenantConfig } from '../api/schemas';
import { breadcrumbJsonLd, jsonLdScript, organizationJsonLd, webSiteJsonLd } from './json-ld';

const tenant: TenantConfig = {
  id: 't1',
  slug: 'mirpur',
  nameBn: 'মিরপুর',
  nameEn: 'Mirpur',
  defaultLocale: 'bn',
  mapCenter: { lat: 23.8, lng: 90.36 },
  radiusKm: null,
  branding: { logoStorageKey: 'tenants/t1/logo.png' },
  featureFlags: {},
  enabledCategories: [],
  emergencyNumbers: [],
  support: { phoneE164: '+8801700000000', email: null, whatsappE164: null },
};
const ORIGIN = 'http://mirpur.localhost:3001';

describe('JSON-LD builders', () => {
  it("describe the tenant's own site, not the platform", () => {
    expect(organizationJsonLd(tenant, ORIGIN)).toMatchObject({
      '@type': 'Organization',
      name: 'মিরপুর',
      url: ORIGIN,
      logo: 'http://storage.test/media/tenants/t1/logo.png',
      telephone: '+8801700000000',
    });
    expect(organizationJsonLd(tenant, ORIGIN)).not.toHaveProperty('email');
    expect(webSiteJsonLd(tenant, ORIGIN)).toMatchObject({ url: ORIGIN, inLanguage: 'bn' });
  });

  it('numbers breadcrumbs from 1 with absolute URLs on the given origin', () => {
    expect(
      breadcrumbJsonLd(
        [
          { name: 'হোম', path: '/' },
          { name: 'ম্যাপ', path: '/map' },
        ],
        ORIGIN,
      ),
    ).toMatchObject({
      itemListElement: [
        { position: 1, item: `${ORIGIN}/` },
        { position: 2, item: `${ORIGIN}/map` },
      ],
    });
  });

  it('escapes < so a value can never close the script tag', () => {
    const hostile = { ...tenant, nameBn: '</script><script>alert(1)</script>' };
    const script = jsonLdScript(organizationJsonLd(hostile, ORIGIN));
    expect(script).not.toContain('</script>');
    expect(JSON.parse(script)).toMatchObject({ name: hostile.nameBn });
  });

  it('emits an array only when given several blocks', () => {
    expect(JSON.parse(jsonLdScript(webSiteJsonLd(tenant, ORIGIN)))).toHaveProperty('@type');
    expect(
      JSON.parse(jsonLdScript(webSiteJsonLd(tenant, ORIGIN), webSiteJsonLd(tenant, ORIGIN))),
    ).toHaveLength(2);
  });
});

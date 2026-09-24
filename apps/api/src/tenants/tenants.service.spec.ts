import type { TenantDb } from '../database/tenant-db';
import type { TenantLookupService } from '../database/tenant-lookup.service';
import type { ResolvedTenant } from '../database/tenant-resolution.types';
import type { SettingsService } from '../settings/settings.service';
import { TenantsService } from './tenants.service';

const TENANT: ResolvedTenant = {
  id: '0191e3a0-6666-7000-8000-00000000000a',
  slug: 'mirpur',
  customDomain: 'mirpur-bazaar.com',
  statusCode: 'active',
};

function buildService(
  overrides: Partial<Record<'resolveBySlug' | 'resolveByCustomDomain', jest.Mock>> = {},
) {
  const lookup = {
    resolveBySlug: overrides.resolveBySlug ?? jest.fn().mockResolvedValue(undefined),
    resolveByCustomDomain:
      overrides.resolveByCustomDomain ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as TenantLookupService;

  const service = new TenantsService(
    undefined as unknown as TenantDb,
    undefined as unknown as SettingsService,
    lookup,
    { APP_ROOT_DOMAIN: 'amarelaka.local' },
  );
  return { service, lookup };
}

describe('TenantsService.resolveByHost', () => {
  it('resolves a subdomain by slug', async () => {
    const resolveBySlug = jest.fn().mockResolvedValue(TENANT);
    const { service } = buildService({ resolveBySlug });

    await expect(service.resolveByHost('mirpur.amarelaka.local:3001')).resolves.toEqual({
      tenantId: TENANT.id,
    });
    expect(resolveBySlug).toHaveBeenCalledWith('mirpur');
  });

  it('resolves a host outside the root domain as a custom domain', async () => {
    const resolveByCustomDomain = jest.fn().mockResolvedValue(TENANT);
    const { service } = buildService({ resolveByCustomDomain });

    await expect(service.resolveByHost('mirpur-bazaar.com')).resolves.toEqual({
      tenantId: TENANT.id,
    });
    expect(resolveByCustomDomain).toHaveBeenCalledWith('mirpur-bazaar.com');
  });

  it('answers tenantId: null for a slug that matches no tenant', async () => {
    const { service } = buildService();

    await expect(service.resolveByHost('unknown.amarelaka.local')).resolves.toEqual({
      tenantId: null,
    });
  });

  it('answers tenantId: null for an unusable *.rootDomain host, without attempting a custom-domain lookup', async () => {
    const resolveByCustomDomain = jest.fn().mockResolvedValue(TENANT);
    const { service } = buildService({ resolveByCustomDomain });

    await expect(service.resolveByHost('a.b.amarelaka.local')).resolves.toEqual({
      tenantId: null,
    });
    expect(resolveByCustomDomain).not.toHaveBeenCalled();
  });
});

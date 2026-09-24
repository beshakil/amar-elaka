import type { TenantCacheStore } from './tenant-cache.ports';
import { TenantContext } from './tenant-context';
import type { TenantDb } from './tenant-db';
import { TenantLookupService } from './tenant-lookup.service';
import type { ResolvedTenant } from './tenant-resolution.types';

class FakeCacheStore implements TenantCacheStore {
  store = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.store.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  del(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
    return Promise.resolve();
  }
}

/** Matches exactly the chain TenantLookupService uses: select().from().where().limit(). */
function fakeTenantDb(rows: ResolvedTenant[]): TenantDb {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(rows),
  };
  return {
    transaction: (work: (tx: unknown) => unknown) => Promise.resolve(work(builder)),
  } as unknown as TenantDb;
}

const TENANT: ResolvedTenant = {
  id: '0191e3a0-5555-7000-8000-00000000000a',
  slug: 'mirpur',
  customDomain: 'mirpur.example.com',
  statusCode: 'active',
};

function buildService(rows: ResolvedTenant[]) {
  const cache = new FakeCacheStore();
  const service = new TenantLookupService(cache, fakeTenantDb(rows), new TenantContext(), {
    TENANT_CACHE_TTL_MS: 300_000,
  });
  return { cache, service };
}

describe('TenantLookupService', () => {
  it('resolves by id on a cache miss and populates all three cache keys', async () => {
    const { cache, service } = buildService([TENANT]);
    await expect(service.resolveById(TENANT.id)).resolves.toEqual(TENANT);

    expect(JSON.parse(cache.store.get(`tenant:id:${TENANT.id}`)!)).toEqual(TENANT);
    expect(JSON.parse(cache.store.get(`tenant:slug:${TENANT.slug}`)!)).toEqual(TENANT);
    expect(JSON.parse(cache.store.get(`tenant:domain:${TENANT.customDomain}`)!)).toEqual(TENANT);
  });

  it('resolves by slug on a cache miss', async () => {
    const { service } = buildService([TENANT]);
    await expect(service.resolveBySlug(TENANT.slug)).resolves.toEqual(TENANT);
  });

  it('resolves by custom domain on a cache miss', async () => {
    const { service } = buildService([TENANT]);
    await expect(service.resolveByCustomDomain(TENANT.customDomain!)).resolves.toEqual(TENANT);
  });

  it('serves from cache without touching the DB on a hit', async () => {
    const { cache, service } = buildService([TENANT]);
    await service.resolveById(TENANT.id); // populates the cache
    // A DB that would throw if it were ever queried again.
    const throwingDb = {
      transaction: () => Promise.reject(new Error('should not query the DB')),
    } as unknown as import('./tenant-db').TenantDb;
    const secondService = new TenantLookupService(cache, throwingDb, new TenantContext(), {
      TENANT_CACHE_TTL_MS: 300_000,
    });
    await expect(secondService.resolveById(TENANT.id)).resolves.toEqual(TENANT);
  });

  it('returns undefined when nothing matches', async () => {
    const { service } = buildService([]);
    await expect(service.resolveById(TENANT.id)).resolves.toBeUndefined();
  });

  it('does not cache a tenant with no custom domain under a domain key', async () => {
    const noDomain: ResolvedTenant = { ...TENANT, customDomain: null };
    const { cache, service } = buildService([noDomain]);
    await service.resolveById(noDomain.id);
    expect([...cache.store.keys()]).toEqual([
      `tenant:id:${noDomain.id}`,
      `tenant:slug:${noDomain.slug}`,
    ]);
  });

  it('invalidate clears all three keys', async () => {
    const { cache, service } = buildService([TENANT]);
    await service.resolveById(TENANT.id);
    expect(cache.store.size).toBe(3);

    await service.invalidate(TENANT);
    expect(cache.store.size).toBe(0);
  });
});

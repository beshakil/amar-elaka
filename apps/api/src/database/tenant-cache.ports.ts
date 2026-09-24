/** Behind a port so TenantLookupService is unit-testable without real Redis. */
export interface TenantCacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export const TENANT_CACHE_STORE = Symbol('TENANT_CACHE_STORE');

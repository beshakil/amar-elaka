/** Behind a port so PermissionsService is unit-testable without real Redis. */
export interface PermissionsCacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  /** Tracks which cache keys exist per tenant, so a role/matrix change can invalidate all of them without a blocking KEYS/SCAN. */
  addToSet(setKey: string, member: string): Promise<void>;
  membersOfSet(setKey: string): Promise<string[]>;
  deleteSet(setKey: string): Promise<void>;
}

export const PERMISSIONS_CACHE_STORE = Symbol('PERMISSIONS_CACHE_STORE');

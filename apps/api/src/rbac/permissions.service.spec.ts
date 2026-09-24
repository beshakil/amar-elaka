import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type { PermissionsCacheStore } from './permissions-cache.ports';
import { PermissionsService } from './permissions.service';

class FakeCacheStore implements PermissionsCacheStore {
  values = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  del(keys: string[]): Promise<void> {
    for (const key of keys) this.values.delete(key);
    return Promise.resolve();
  }
  addToSet(setKey: string, member: string): Promise<void> {
    (this.sets.get(setKey) ?? this.sets.set(setKey, new Set()).get(setKey)!).add(member);
    return Promise.resolve();
  }
  membersOfSet(setKey: string): Promise<string[]> {
    return Promise.resolve([...(this.sets.get(setKey) ?? [])]);
  }
  deleteSet(setKey: string): Promise<void> {
    this.sets.delete(setKey);
    return Promise.resolve();
  }
}

const NOT_PLATFORM_ADMIN = [{ platform_role_code: null }];

/**
 * Each individual `tx.execute()` call — not each `.transaction()` call —
 * consumes the next queued row set. loadEffective always issues the
 * platform_role_code check first, then (unless that short-circuits) the
 * tenant_members/role_permissions query, so most tests queue
 * NOT_PLATFORM_ADMIN before their actual grants row set.
 */
class FakeTenantDb {
  private queue: Array<Record<string, unknown>[]> = [];
  queueRows(rows: Record<string, unknown>[]): void {
    this.queue.push(rows);
  }
  transaction(work: (tx: unknown) => unknown): Promise<unknown> {
    return Promise.resolve(work({ execute: () => Promise.resolve(this.queue.shift() ?? []) }));
  }
}

function buildService(tenantDb: FakeTenantDb, ttlMs = 300_000) {
  const cache = new FakeCacheStore();
  const context = new TenantContext();
  const service = new PermissionsService(cache, tenantDb as unknown as TenantDb, context, {
    PERMISSIONS_CACHE_TTL_MS: ttlMs,
  });
  return { cache, context, service };
}

const TENANT_A = '0191e3a0-aaaa-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-aaaa-7000-8000-00000000000b';
const USER = '0191e3a0-aaaa-7000-8000-00000000001a';

describe('PermissionsService', () => {
  it('resolves grants from the DB on a cache miss', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([
      { module: 'posts', action: 'read' },
      { module: 'posts', action: 'write' },
    ]);
    const { service } = buildService(db);

    await expect(service.getGrants(TENANT_A, USER)).resolves.toEqual([
      { module: 'posts', action: 'read' },
      { module: 'posts', action: 'write' },
    ]);
  });

  it('serves from cache on the second call, without touching the DB again', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: 'posts', action: 'read' }]);
    const { service } = buildService(db);

    await service.getGrants(TENANT_A, USER);
    // Nothing else queued — a DB hit here would resolve to [] instead.
    await expect(service.getGrants(TENANT_A, USER)).resolves.toEqual([
      { module: 'posts', action: 'read' },
    ]);
  });

  it('a role with no membership row in a tenant resolves to zero grants there — tenant isolation, not just RLS', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: 'posts', action: 'approve' }]); // tenant A: this user is a moderator
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([]); // tenant B: no tenant_members row for this user at all
    const { service } = buildService(db);

    await expect(service.can(TENANT_A, USER, 'posts', 'approve')).resolves.toBe(true);
    await expect(service.can(TENANT_B, USER, 'posts', 'approve')).resolves.toBe(false);
  });

  it('wildcard module and action match anything (tenant_admin shape)', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: '*', action: '*' }]);
    const { service } = buildService(db);

    await expect(service.can(TENANT_A, USER, 'campaigns', 'delete')).resolves.toBe(true);
  });

  it('a wildcard action with a specific module only matches that module', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: 'posts', action: '*' }]);
    const { service } = buildService(db);

    await expect(service.can(TENANT_A, USER, 'posts', 'delete')).resolves.toBe(true);
    await expect(service.can(TENANT_A, USER, 'ads', 'read')).resolves.toBe(false);
  });

  it('platform_admin is verified fresh from the DB (users.platform_role_code), not just trusted from context', async () => {
    const db = new FakeTenantDb();
    db.queueRows([{ platform_role_code: 'platform_admin' }]); // the only row queued — the second query must never run
    const { service } = buildService(db);

    await expect(service.can(TENANT_A, USER, 'anything', 'delete')).resolves.toBe(true);
    const effective = await service.getEffective(TENANT_A, USER);
    expect(effective.isPlatformAdmin).toBe(true);
  });

  it('also short-circuits on the TenantContext fast path, when PlatformAdminGuard already ran', async () => {
    const db = new FakeTenantDb(); // no rows queued at all — a DB hit here would throw
    const { service, context } = buildService(db);

    await context.run({ role: 'platform_admin' }, async () => {
      await expect(service.can(TENANT_A, USER, 'anything', 'delete')).resolves.toBe(true);
    });
  });

  it('invalidateUser clears just that cache entry', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: 'posts', action: 'read' }]);
    const { service, cache } = buildService(db);

    await service.getGrants(TENANT_A, USER);
    await service.invalidateUser(TENANT_A, USER);
    expect(cache.values.size).toBe(0);
  });

  it('invalidateTenant clears every cached user for that tenant via the index set, not a table scan', async () => {
    const db = new FakeTenantDb();
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: 'posts', action: 'read' }]);
    db.queueRows(NOT_PLATFORM_ADMIN);
    db.queueRows([{ module: 'posts', action: 'write' }]);
    const { service, cache } = buildService(db);
    const otherUser = '0191e3a0-aaaa-7000-8000-00000000002a';

    await service.getGrants(TENANT_A, USER);
    await service.getGrants(TENANT_A, otherUser);
    expect(cache.values.size).toBe(2);

    await service.invalidateTenant(TENANT_A);
    expect(cache.values.size).toBe(0);
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { tenants } from './schema/tenancy';
import { TENANT_CACHE_STORE, type TenantCacheStore } from './tenant-cache.ports';
import { TenantContext } from './tenant-context';
import { TenantDb } from './tenant-db';
import type { ResolvedTenant } from './tenant-resolution.types';

function idKey(id: string): string {
  return `tenant:id:${id}`;
}
function slugKey(slug: string): string {
  return `tenant:slug:${slug}`;
}
function domainKey(domain: string): string {
  return `tenant:domain:${domain}`;
}

/**
 * The shared cache-or-Postgres tenant resolver. Reads/writes Redis directly
 * (no in-process layer), so every API instance shares one 5-minute cache and
 * invalidation is a plain DEL — no pub/sub needed (contrast
 * apps/api/src/settings, which layers an in-process cache on top of Postgres
 * and therefore does need one).
 */
@Injectable()
export class TenantLookupService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(TENANT_CACHE_STORE) private readonly cache: TenantCacheStore,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    @Inject(APP_CONFIG) env: Pick<Env, 'TENANT_CACHE_TTL_MS'>,
  ) {
    // settings-exempt: milliseconds-to-seconds, not a business threshold.
    this.ttlSeconds = Math.max(1, Math.round(env.TENANT_CACHE_TTL_MS / 1000));
  }

  async resolveById(id: string): Promise<ResolvedTenant | undefined> {
    return this.resolve(idKey(id), () => this.queryTenant(eq(tenants.id, id)));
  }

  async resolveBySlug(slug: string): Promise<ResolvedTenant | undefined> {
    return this.resolve(slugKey(slug), () => this.queryTenant(eq(tenants.slug, slug)));
  }

  async resolveByCustomDomain(domain: string): Promise<ResolvedTenant | undefined> {
    return this.resolve(domainKey(domain), () =>
      this.queryTenant(eq(tenants.customDomain, domain)),
    );
  }

  /** Ready for a future tenant-update endpoint to call; nothing in this codebase mutates tenants yet. */
  async invalidate(tenant: Pick<ResolvedTenant, 'id' | 'slug' | 'customDomain'>): Promise<void> {
    const keys = [idKey(tenant.id), slugKey(tenant.slug)];
    if (tenant.customDomain) keys.push(domainKey(tenant.customDomain));
    await this.cache.del(keys);
  }

  private async resolve(
    cacheKey: string,
    load: () => Promise<ResolvedTenant | undefined>,
  ): Promise<ResolvedTenant | undefined> {
    const cached = await this.cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as ResolvedTenant;

    const tenant = await load();
    if (!tenant) return undefined;

    const serialized = JSON.stringify(tenant);
    await Promise.all([
      this.cache.set(idKey(tenant.id), serialized, this.ttlSeconds),
      this.cache.set(slugKey(tenant.slug), serialized, this.ttlSeconds),
      tenant.customDomain
        ? this.cache.set(domainKey(tenant.customDomain), serialized, this.ttlSeconds)
        : Promise.resolve(),
    ]);
    return tenant;
  }

  /** Cross-tenant by nature (resolving *which* tenant this is), so this reads as `system`, same idiom as PgSettingsSource. */
  private queryTenant(
    condition: NonNullable<Parameters<typeof and>[0]>,
  ): Promise<ResolvedTenant | undefined> {
    return this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction(
        async (tx) => {
          const [row] = await tx
            .select({
              id: tenants.id,
              slug: tenants.slug,
              customDomain: tenants.customDomain,
              statusCode: tenants.statusCode,
            })
            .from(tenants)
            .where(and(condition, ne(tenants.statusCode, 'archived')))
            .limit(1);
          return row;
        },
        { accessMode: 'read only' },
      ),
    );
  }
}

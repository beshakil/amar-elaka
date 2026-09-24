import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { EffectivePermissions, Grant } from './dto/rbac-responses.dto';
import { PERMISSIONS_CACHE_STORE, type PermissionsCacheStore } from './permissions-cache.ports';

const GrantRow = z.object({ module: z.string(), action: z.string() });
const PlatformRoleRow = z.object({ platform_role_code: z.string().nullable() });
const WILDCARD: EffectivePermissions = {
  isPlatformAdmin: true,
  grants: [{ module: '*', action: '*' }],
};

function grantsKey(tenantId: string, userId: string): string {
  return `perm:grants:${tenantId}:${userId}`;
}
function tenantIndexKey(tenantId: string): string {
  return `perm:tenant-index:${tenantId}`;
}

/**
 * Resolves a tenant member's effective module -> action grants: their
 * custom role's matrix if `tenant_members.custom_role_id` is set, otherwise
 * the built-in role matching `role_code` (infra/migrations/0015_rbac.sql).
 * No membership row in the given tenant -> no grants at all, which is what
 * makes tenant isolation hold here, not just in RLS.
 *
 * Platform admin is a global `users.platform_role_code` attribute, not a
 * tenant_members row, and is checked fresh from the DB (cached the same as
 * everything else) rather than trusted from TenantContext — a caller might
 * reach a plain `@RequirePermission()` route that PlatformAdminGuard never
 * ran on, and a platform admin must still pass it.
 */
@Injectable()
export class PermissionsService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(PERMISSIONS_CACHE_STORE) private readonly cache: PermissionsCacheStore,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    @Inject(APP_CONFIG) env: Pick<Env, 'PERMISSIONS_CACHE_TTL_MS'>,
  ) {
    // settings-exempt: milliseconds-to-seconds, not a business threshold.
    this.ttlSeconds = Math.max(1, Math.round(env.PERMISSIONS_CACHE_TTL_MS / 1000));
  }

  async getEffective(tenantId: string, userId: string): Promise<EffectivePermissions> {
    // Fast path: PlatformAdminGuard (@PlatformAdmin() routes) already did the
    // DB-verified check and switched the context role — skip a second lookup.
    if (this.tenantContext.current()?.role === 'platform_admin') {
      return WILDCARD;
    }

    const cached = await this.cache.get(grantsKey(tenantId, userId));
    if (cached) return JSON.parse(cached) as EffectivePermissions;

    const effective = await this.loadEffective(tenantId, userId);
    await this.cache.set(grantsKey(tenantId, userId), JSON.stringify(effective), this.ttlSeconds);
    await this.cache.addToSet(tenantIndexKey(tenantId), userId);
    return effective;
  }

  async can(tenantId: string, userId: string, module: string, action: string): Promise<boolean> {
    const { grants } = await this.getEffective(tenantId, userId);
    return grants.some(
      (grant) =>
        (grant.module === '*' || grant.module === module) &&
        (grant.action === '*' || grant.action === action),
    );
  }

  async getGrants(tenantId: string, userId: string): Promise<Grant[]> {
    return (await this.getEffective(tenantId, userId)).grants;
  }

  /** Call after assigning a member a different role_code/custom_role_id. */
  async invalidateUser(tenantId: string, userId: string): Promise<void> {
    await this.cache.del([grantsKey(tenantId, userId)]);
  }

  /** Call after creating/editing a role's matrix — every member who might hold it needs a fresh lookup. */
  async invalidateTenant(tenantId: string): Promise<void> {
    const userIds = await this.cache.membersOfSet(tenantIndexKey(tenantId));
    await this.cache.del(userIds.map((userId) => grantsKey(tenantId, userId)));
    await this.cache.deleteSet(tenantIndexKey(tenantId));
  }

  /**
   * Explicit (tenantId, userId) params, not the ambient request context —
   * this must answer correctly for *any* pair (e.g. "does this moderator
   * have grants in a tenant they don't belong to"), not just "am I allowed
   * to check my own". Runs as `system`, same idiom as PgSettingsSource /
   * TenantLookupService, so the query's own WHERE clause is what scopes it,
   * not whatever RLS context the caller happens to be in.
   */
  private loadEffective(tenantId: string, userId: string): Promise<EffectivePermissions> {
    return this.tenantContext.run({ role: 'system' }, () =>
      this.tenantDb.transaction(
        async (tx) => {
          const platformRows = await tx.execute(sql`
          select platform_role_code from public.users where id = ${userId}
        `);
          const [platformRow] = z.array(PlatformRoleRow).parse([...platformRows]);
          if (platformRow?.platform_role_code === 'platform_admin') {
            return WILDCARD;
          }

          const rows = await tx.execute(sql`
          with member as (
            select tm.role_code, tm.custom_role_id
            from public.tenant_members tm
            where tm.tenant_id = ${tenantId} and tm.user_id = ${userId}
            limit 1
          ),
          effective_role as (
            select coalesce(
              member.custom_role_id,
              (select id from public.roles where tenant_id is null and code = member.role_code)
            ) as role_id
            from member
          )
          select rp.module, rp.action
          from effective_role
          join public.role_permissions rp on rp.role_id = effective_role.role_id
        `);
          return { isPlatformAdmin: false, grants: z.array(GrantRow).parse([...rows]) };
        },
        { accessMode: 'read only' },
      ),
    );
  }
}

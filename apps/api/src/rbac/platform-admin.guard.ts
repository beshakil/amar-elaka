import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { users } from '../database/schema/identity';
import { TenantContext, type AppRole } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PlatformAccessRequiredException } from './platform-admin.exception';

const PLATFORM_ROLES = new Set<string>(['platform_admin', 'platform_support', 'platform_finance']);

/**
 * Runs JwtAuthGuard first (same access-token verification every authenticated
 * route uses), then checks the caller's *platform* role — a global attribute
 * on `users.platform_role_code`, unrelated to their tenant membership role
 * and not carried in the access token, so this does its own fresh,
 * single-row lookup (`users_self_read` RLS already allows a user to read
 * their own row) rather than trusting a claim. Applied via `@PlatformAdmin()`.
 *
 * "Platform scope" admits any platform staff role (admin/support/finance),
 * not only `platform_admin` — narrower per-action checks belong to
 * individual endpoints once they exist, not to this gate.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtAuthGuard.canActivate(context);

    const userId = this.tenantContext.require().userId;
    if (!userId) throw new PlatformAccessRequiredException();

    const platformRole = await this.tenantDb.transaction(async (tx) => {
      const [row] = await tx
        .select({ platformRoleCode: users.platformRoleCode })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row?.platformRoleCode ?? null;
    });

    if (!platformRole || !PLATFORM_ROLES.has(platformRole)) {
      throw new PlatformAccessRequiredException();
    }

    this.tenantContext.set({ role: platformRole as AppRole });
    return true;
  }
}

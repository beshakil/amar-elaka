import {
  applyDecorators,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { TenantContext } from '../database/tenant-context';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from '../rbac/permission.metadata';
import { PlatformAdminGuard } from '../rbac/platform-admin.guard';
import { PlatformAdminRoleRequiredException } from './categories.exceptions';

/**
 * PlatformAdminGuard admits any platform staff role (admin, support,
 * finance) and leaves narrower checks to each endpoint. The global taxonomy
 * is changed by platform admins only, and RLS agrees: `is_platform_admin()`
 * is only true for them (TenantDb's RLS_BYPASS_ROLES).
 */
@Injectable()
export class PlatformAdminOnlyGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContext) {}

  canActivate(): boolean {
    if (this.tenantContext.current()?.role !== 'platform_admin') {
      throw new PlatformAdminRoleRequiredException();
    }
    return true;
  }
}

/**
 * Platform-admin-only category route. Also records `categories:<action>` as
 * the route's permission metadata: no permission guard reads it here (the
 * guards above already decided), but the global AuditLogInterceptor does, so
 * every write/delete to the global taxonomy lands in audit_logs.
 */
export const PlatformAdminOnly = (
  action: 'read' | 'write' | 'delete',
): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    AllowAnyTenant(),
    UseGuards(JwtAuthGuard, PlatformAdminGuard, PlatformAdminOnlyGuard),
    SetMetadata(REQUIRE_PERMISSION_KEY, {
      module: 'categories',
      action,
    } satisfies RequiredPermission),
  );

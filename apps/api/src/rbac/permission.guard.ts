import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from './permission.metadata';
import { PermissionsService } from './permissions.service';
import { PermissionDeniedException } from './rbac.exceptions';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const { userId, tenantId } = this.tenantContext.require();
    if (!userId || !tenantId) throw new TenantRequiredException();

    const allowed = await this.permissions.can(tenantId, userId, required.module, required.action);
    if (!allowed) throw new PermissionDeniedException(required.module, required.action);
    return true;
  }
}

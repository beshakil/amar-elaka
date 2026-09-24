import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from './permission.guard';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from './permission.metadata';

/** Authenticates the caller, then requires module:action from their effective grants (rbac/permissions.service.ts). Also read by AuditLogInterceptor. */
export const RequirePermission = (
  module: string,
  action: string,
): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    SetMetadata(REQUIRE_PERMISSION_KEY, { module, action } satisfies RequiredPermission),
    UseGuards(JwtAuthGuard, PermissionGuard),
  );

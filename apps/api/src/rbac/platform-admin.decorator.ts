import { applyDecorators, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Platform-staff-only route, operating cross-tenant: authenticates the
 * caller, requires a platform role, and switches TenantContext into
 * platform scope. Implies `@AllowAnyTenant()` — platform routes don't
 * belong to any one tenant, so TenantGateGuard shouldn't require one to
 * have resolved. Any module using this must import RbacModule.
 */
export const PlatformAdmin = (): ReturnType<typeof applyDecorators> =>
  applyDecorators(AllowAnyTenant(), UseGuards(JwtAuthGuard, PlatformAdminGuard));

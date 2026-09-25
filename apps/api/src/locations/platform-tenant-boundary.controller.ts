import {
  Body,
  Controller,
  Injectable,
  Param,
  Put,
  SetMetadata,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { TenantContext } from '../database/tenant-context';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from '../rbac/permission.metadata';
import { PlatformAdminGuard } from '../rbac/platform-admin.guard';
import {
  TenantBoundaryDto,
  TenantBoundaryResponseDto,
  TenantIdParamDto,
  toBoundaryInput,
  type TenantBoundaryResponse,
} from './dto/locations.dto';
import { PlatformAdminRequiredException } from './locations.exceptions';
import { LocationsService } from './locations.service';

/** Platform admins only (not support/finance); RLS agrees (is_platform_admin). */
@Injectable()
export class TenantBoundaryAdminGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContext) {}

  canActivate(): boolean {
    if (this.tenantContext.current()?.role !== 'platform_admin')
      throw new PlatformAdminRequiredException();
    return true;
  }
}

@Controller({ path: 'platform/tenants', version: '1' })
@AllowAnyTenant()
@UseGuards(JwtAuthGuard, PlatformAdminGuard, TenantBoundaryAdminGuard)
// Read by the global AuditLogInterceptor: every boundary change lands in audit_logs.
@SetMetadata(REQUIRE_PERMISSION_KEY, {
  module: 'tenants',
  action: 'write',
} satisfies RequiredPermission)
export class PlatformTenantBoundaryController {
  constructor(private readonly locations: LocationsService) {}

  /** Set a tenant's service area: its area polygon, or a centre and radius. */
  @Put(':tenantId/boundary')
  @ApiOkResponse({ type: TenantBoundaryResponseDto })
  setBoundary(
    @Param() params: TenantIdParamDto,
    @Body() body: TenantBoundaryDto,
  ): Promise<TenantBoundaryResponse> {
    return this.locations.setTenantBoundary(params.tenantId, toBoundaryInput(body));
  }
}

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { MyPermissionsDto, type MyPermissions } from './dto/rbac-responses.dto';
import { PermissionsService } from './permissions.service';

@Controller({ path: 'me', version: '1' })
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContext,
  ) {}

  @Get('permissions')
  @ApiOkResponse({ type: MyPermissionsDto })
  async getPermissions(): Promise<MyPermissions> {
    const { userId, tenantId, role } = this.tenantContext.require();
    if (!userId || !tenantId) throw new TenantRequiredException();
    const effective = await this.permissions.getEffective(tenantId, userId);
    return { ...effective, role };
  }
}

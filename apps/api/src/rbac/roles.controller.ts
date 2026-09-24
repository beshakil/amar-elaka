import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { RoleIdParamDto } from './dto/role-id-param.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleAssignedDto, RoleDto, type RoleWithPermissions } from './dto/rbac-responses.dto';
import { RequirePermission } from './require-permission.decorator';
import { RolesService } from './roles.service';

@Controller({ version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post('roles')
  @RequirePermission('roles', 'write')
  @ApiCreatedResponse({ type: RoleDto })
  create(@Body() body: CreateRoleDto): Promise<RoleWithPermissions> {
    return this.roles.create(body.name, body.permissions);
  }

  @Get('roles')
  @RequirePermission('roles', 'read')
  @ApiOkResponse({ type: RoleDto, isArray: true })
  list(): Promise<RoleWithPermissions[]> {
    return this.roles.list();
  }

  @Patch('roles/:roleId')
  @RequirePermission('roles', 'write')
  @ApiOkResponse({ type: RoleDto })
  update(
    @Param() params: RoleIdParamDto,
    @Body() body: UpdateRoleDto,
  ): Promise<RoleWithPermissions> {
    return this.roles.update(params.roleId, body);
  }

  @Delete('roles/:roleId')
  @RequirePermission('roles', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: "Deleted; the role's members fall back to their built-in role.",
  })
  async remove(@Param() params: RoleIdParamDto): Promise<void> {
    await this.roles.remove(params.roleId);
  }

  @Patch('tenant-members/:memberId/role')
  @RequirePermission('roles', 'write')
  @ApiOkResponse({ type: RoleAssignedDto })
  async assign(
    @Param('memberId') memberId: string,
    @Body() body: AssignRoleDto,
  ): Promise<{ status: 'assigned' }> {
    await this.roles.assign(memberId, body);
    return { status: 'assigned' };
  }
}

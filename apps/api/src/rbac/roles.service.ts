import { Injectable } from '@nestjs/common';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantContext } from '../database/tenant-context';
import type { Grant, RoleWithPermissions } from './dto/rbac-responses.dto';
import { PermissionsService } from './permissions.service';
import { RolesRepository, type RoleMutationResult } from './roles.repository';
import {
  BuiltinRoleImmutableException,
  RoleAlreadyExistsException,
  RoleNotFoundException,
  TenantMemberNotFoundException,
} from './rbac.exceptions';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CUSTOM_ROLE_TENANT_MISMATCH = 'AE010';

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'role';
}

@Injectable()
export class RolesService {
  constructor(
    private readonly repo: RolesRepository,
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContext,
  ) {}

  async create(name: string, permissions: Grant[]): Promise<RoleWithPermissions> {
    const tenantId = this.tenantContext.require().tenantId!;
    try {
      return await this.repo.create(tenantId, slugify(name), name, permissions);
    } catch (error) {
      if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new RoleAlreadyExistsException();
      throw error;
    }
  }

  list(): Promise<RoleWithPermissions[]> {
    const tenantId = this.tenantContext.require().tenantId!;
    return this.repo.listForTenant(tenantId);
  }

  async update(
    roleId: string,
    changes: { name?: string | undefined; permissions?: Grant[] | undefined },
  ): Promise<RoleWithPermissions> {
    const tenantId = this.tenantContext.require().tenantId!;
    const role = unwrap(await this.repo.updateRole(tenantId, roleId, changes));
    // Every member holding this role must see the new matrix on their very
    // next request, not after the permissions cache expires.
    if (changes.permissions !== undefined) await this.permissions.invalidateTenant(tenantId);
    return role;
  }

  async remove(roleId: string): Promise<void> {
    const tenantId = this.tenantContext.require().tenantId!;
    unwrap(await this.repo.deleteRole(tenantId, roleId));
    // Its members just fell back to their built-in role_code (ON DELETE SET NULL).
    await this.permissions.invalidateTenant(tenantId);
  }

  async assign(
    memberId: string,
    body: { roleCode?: string | undefined; customRoleId?: string | undefined },
  ): Promise<void> {
    const tenantId = this.tenantContext.require().tenantId!;

    let userId: string | undefined;
    try {
      userId = body.customRoleId
        ? await this.repo.assignCustomRole(tenantId, memberId, body.customRoleId)
        : await this.repo.assignRoleCode(tenantId, memberId, body.roleCode!);
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (sqlState === FOREIGN_KEY_VIOLATION || sqlState === CUSTOM_ROLE_TENANT_MISMATCH) {
        throw new RoleNotFoundException();
      }
      throw error;
    }

    if (!userId) throw new TenantMemberNotFoundException();
    await this.permissions.invalidateUser(tenantId, userId);
  }
}

function unwrap<T>(result: RoleMutationResult<T>): T {
  switch (result.kind) {
    case 'done':
      return result.value;
    case 'builtin':
      throw new BuiltinRoleImmutableException();
    case 'not_found':
      throw new RoleNotFoundException();
  }
}

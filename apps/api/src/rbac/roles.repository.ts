import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.client';
import { roles, rolePermissions } from '../database/schema/rbac';
import { tenantMembers } from '../database/schema/tenancy';
import { TenantDb } from '../database/tenant-db';
import type { Grant, RoleWithPermissions } from './dto/rbac-responses.dto';

export type RoleMutationResult<T> =
  { kind: 'done'; value: T } | { kind: 'builtin' } | { kind: 'not_found' };

@Injectable()
export class RolesRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  async create(
    tenantId: string,
    code: string,
    name: string,
    permissions: Grant[],
  ): Promise<RoleWithPermissions> {
    return this.tenantDb.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({ tenantId, code, name, isBuiltin: false })
        .returning({
          id: roles.id,
          code: roles.code,
          name: roles.name,
          isBuiltin: roles.isBuiltin,
        });
      await tx
        .insert(rolePermissions)
        .values(permissions.map((grant) => ({ roleId: role!.id, ...grant })));
      return { ...role!, permissions };
    });
  }

  async listForTenant(tenantId: string): Promise<RoleWithPermissions[]> {
    return this.tenantDb.transaction(
      async (tx) => {
        const roleRows = await tx
          .select({ id: roles.id, code: roles.code, name: roles.name, isBuiltin: roles.isBuiltin })
          .from(roles)
          .where(or(isNull(roles.tenantId), eq(roles.tenantId, tenantId)));

        const permissionRows = await tx
          .select({
            roleId: rolePermissions.roleId,
            module: rolePermissions.module,
            action: rolePermissions.action,
          })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .where(or(isNull(roles.tenantId), eq(roles.tenantId, tenantId)));

        return roleRows.map((role) => ({
          ...role,
          permissions: permissionRows
            .filter((row) => row.roleId === role.id)
            .map(({ module, action }) => ({ module, action })),
        }));
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * Renames and/or replaces the permission matrix of one of this tenant's own
   * roles, in one transaction. Built-ins are visible to every tenant (RLS
   * `roles_read`) but never writable here: the check is explicit so the
   * caller can say *why*, and the write is still scoped to `tenant_id` so a
   * built-in could not be touched even if the check were skipped.
   */
  async updateRole(
    tenantId: string,
    roleId: string,
    changes: { name?: string | undefined; permissions?: Grant[] | undefined },
  ): Promise<RoleMutationResult<RoleWithPermissions>> {
    return this.tenantDb.transaction(async (tx) => {
      const visibility = await this.visibility(tx, tenantId, roleId);
      if (visibility !== 'own') return { kind: visibility };

      // Always touch the row, even for a permissions-only change, so
      // updated_at (roles_set_updated_at) reflects the matrix change too.
      // `code` is deliberately left alone: it is the role's identifier, and
      // renaming a role must not change what it is.
      const [role] = await tx
        .update(roles)
        .set(changes.name !== undefined ? { name: changes.name } : { updatedAt: sql`now()` })
        .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
        .returning({
          id: roles.id,
          code: roles.code,
          name: roles.name,
          isBuiltin: roles.isBuiltin,
        });
      if (!role) return { kind: 'not_found' };

      if (changes.permissions !== undefined) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        await tx
          .insert(rolePermissions)
          .values(changes.permissions.map((grant) => ({ roleId, ...grant })));
      }

      const permissions = await tx
        .select({ module: rolePermissions.module, action: rolePermissions.action })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleId));

      return { kind: 'done', value: { ...role, permissions } };
    });
  }

  /**
   * Members holding the role fall back to their built-in `role_code`:
   * `tenant_members.custom_role_id` is `ON DELETE SET NULL`, and
   * `role_permissions` cascades.
   */
  async deleteRole(tenantId: string, roleId: string): Promise<RoleMutationResult<null>> {
    return this.tenantDb.transaction(async (tx) => {
      const visibility = await this.visibility(tx, tenantId, roleId);
      if (visibility !== 'own') return { kind: visibility };

      const [deleted] = await tx
        .delete(roles)
        .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
        .returning({ id: roles.id });
      return deleted ? { kind: 'done', value: null } : { kind: 'not_found' };
    });
  }

  private async visibility(
    tx: DatabaseTransaction,
    tenantId: string,
    roleId: string,
  ): Promise<'own' | 'builtin' | 'not_found'> {
    const [row] = await tx
      .select({ tenantId: roles.tenantId })
      .from(roles)
      .where(and(eq(roles.id, roleId), or(isNull(roles.tenantId), eq(roles.tenantId, tenantId))))
      .limit(1);
    if (!row) return 'not_found';
    return row.tenantId === null ? 'builtin' : 'own';
  }

  /** Returns the target member's userId (for cache invalidation) if the update matched a row in this tenant, else undefined. */
  async assignRoleCode(
    tenantId: string,
    memberId: string,
    roleCode: string,
  ): Promise<string | undefined> {
    return this.update(tenantId, memberId, { roleCode, customRoleId: null });
  }

  async assignCustomRole(
    tenantId: string,
    memberId: string,
    customRoleId: string,
  ): Promise<string | undefined> {
    return this.update(tenantId, memberId, { customRoleId });
  }

  private async update(
    tenantId: string,
    memberId: string,
    values: Partial<{ roleCode: string; customRoleId: string | null }>,
  ): Promise<string | undefined> {
    return this.tenantDb.transaction(async (tx: DatabaseTransaction) => {
      const [row] = await tx
        .update(tenantMembers)
        .set(values)
        .where(and(eq(tenantMembers.id, memberId), eq(tenantMembers.tenantId, tenantId)))
        .returning({ userId: tenantMembers.userId });
      return row?.userId;
    });
  }
}

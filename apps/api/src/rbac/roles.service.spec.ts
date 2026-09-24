import { TenantContext } from '../database/tenant-context';
import type { PermissionsService } from './permissions.service';
import { BuiltinRoleImmutableException, RoleNotFoundException } from './rbac.exceptions';
import type { RoleWithPermissions } from './dto/rbac-responses.dto';
import type { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

const TENANT_ID = '0191e3a0-6666-7000-8000-00000000000a';
const ROLE_ID = '0191e3a0-7777-7000-8000-00000000000b';

const ROLE: RoleWithPermissions = {
  id: ROLE_ID,
  code: 'content_reviewer',
  name: 'Content Reviewer',
  isBuiltin: false,
  permissions: [{ module: 'posts', action: 'read' }],
};

function build(repo: Partial<Record<'updateRole' | 'deleteRole', jest.Mock>>) {
  const repository = {
    updateRole: repo.updateRole ?? jest.fn(),
    deleteRole: repo.deleteRole ?? jest.fn(),
  } as unknown as RolesRepository;
  const invalidateTenant = jest.fn().mockResolvedValue(undefined);
  const permissions = { invalidateTenant } as unknown as PermissionsService;
  const context = new TenantContext();
  const service = new RolesService(repository, permissions, context);

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return context.run({ tenantId: TENANT_ID }, fn);
  }

  return { service, invalidateTenant, run };
}

describe('RolesService.update', () => {
  it('returns the updated role and invalidates the tenant when the matrix changed', async () => {
    const update = jest.fn().mockResolvedValue({ kind: 'done', value: ROLE });
    const { service, invalidateTenant, run } = build({ updateRole: update });

    const changes = { permissions: [{ module: 'posts', action: 'read' }] };
    await expect(run(() => service.update(ROLE_ID, changes))).resolves.toEqual(ROLE);

    expect(update).toHaveBeenCalledWith(TENANT_ID, ROLE_ID, changes);
    expect(invalidateTenant).toHaveBeenCalledWith(TENANT_ID);
  });

  it('does not invalidate permissions for a rename alone — no grant changed', async () => {
    const update = jest.fn().mockResolvedValue({ kind: 'done', value: ROLE });
    const { service, invalidateTenant, run } = build({ updateRole: update });

    await run(() => service.update(ROLE_ID, { name: 'Reviewer' }));

    expect(invalidateTenant).not.toHaveBeenCalled();
  });

  it('refuses a built-in role', async () => {
    const { service, invalidateTenant, run } = build({
      updateRole: jest.fn().mockResolvedValue({ kind: 'builtin' }),
    });

    await expect(run(() => service.update(ROLE_ID, { name: 'Mod' }))).rejects.toBeInstanceOf(
      BuiltinRoleImmutableException,
    );
    expect(invalidateTenant).not.toHaveBeenCalled();
  });

  it('is not found for a role outside this tenant', async () => {
    const { service, run } = build({
      updateRole: jest.fn().mockResolvedValue({ kind: 'not_found' }),
    });

    await expect(run(() => service.update(ROLE_ID, { name: 'X' }))).rejects.toBeInstanceOf(
      RoleNotFoundException,
    );
  });
});

describe('RolesService.remove', () => {
  it('deletes and invalidates the tenant, since its members fell back to their built-in role', async () => {
    const remove = jest.fn().mockResolvedValue({ kind: 'done', value: null });
    const { service, invalidateTenant, run } = build({ deleteRole: remove });

    await run(() => service.remove(ROLE_ID));

    expect(remove).toHaveBeenCalledWith(TENANT_ID, ROLE_ID);
    expect(invalidateTenant).toHaveBeenCalledWith(TENANT_ID);
  });

  it('refuses a built-in role without touching the cache', async () => {
    const { service, invalidateTenant, run } = build({
      deleteRole: jest.fn().mockResolvedValue({ kind: 'builtin' }),
    });

    await expect(run(() => service.remove(ROLE_ID))).rejects.toBeInstanceOf(
      BuiltinRoleImmutableException,
    );
    expect(invalidateTenant).not.toHaveBeenCalled();
  });

  it('is not found for an unknown role', async () => {
    const { service, run } = build({
      deleteRole: jest.fn().mockResolvedValue({ kind: 'not_found' }),
    });

    await expect(run(() => service.remove(ROLE_ID))).rejects.toBeInstanceOf(RoleNotFoundException);
  });
});

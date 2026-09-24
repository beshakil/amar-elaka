import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { PermissionGuard } from './permission.guard';
import type { RequiredPermission } from './permission.metadata';
import type { PermissionsService } from './permissions.service';
import { PermissionDeniedException } from './rbac.exceptions';

const TENANT = '0191e3a0-bbbb-7000-8000-00000000000a';
const USER = '0191e3a0-bbbb-7000-8000-00000000001a';

const FAKE_EXECUTION_CONTEXT = {
  getHandler: () => undefined,
  getClass: () => undefined,
} as unknown as ExecutionContext;

function buildGuard(required: RequiredPermission | undefined, can: boolean) {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  // Standalone spy — asserting via `permissions.can` trips unbound-method against the real class type.
  const canSpy = jest.fn().mockResolvedValue(can);
  const permissions = { can: canSpy } as unknown as PermissionsService;
  const context = new TenantContext();
  const guard = new PermissionGuard(reflector, permissions, context);
  return { guard, canSpy, context };
}

describe('PermissionGuard', () => {
  it('passes routes with no @RequirePermission metadata', async () => {
    const { guard, context } = buildGuard(undefined, false);
    await expect(context.run({}, () => guard.canActivate(FAKE_EXECUTION_CONTEXT))).resolves.toBe(
      true,
    );
  });

  it('throws if there is no tenant/user resolved', async () => {
    const { guard, context } = buildGuard({ module: 'posts', action: 'read' }, true);
    await expect(
      context.run({}, () => guard.canActivate(FAKE_EXECUTION_CONTEXT)),
    ).rejects.toBeInstanceOf(TenantRequiredException);
  });

  it('denies when PermissionsService.can() returns false', async () => {
    const required = { module: 'posts', action: 'approve' };
    const { guard, context, canSpy } = buildGuard(required, false);

    await expect(
      context.run({ tenantId: TENANT, userId: USER }, () =>
        guard.canActivate(FAKE_EXECUTION_CONTEXT),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(canSpy).toHaveBeenCalledWith(TENANT, USER, 'posts', 'approve');
  });

  it('allows when PermissionsService.can() returns true', async () => {
    const required = { module: 'posts', action: 'read' };
    const { guard, context } = buildGuard(required, true);

    await expect(
      context.run({ tenantId: TENANT, userId: USER }, () =>
        guard.canActivate(FAKE_EXECUTION_CONTEXT),
      ),
    ).resolves.toBe(true);
  });
});

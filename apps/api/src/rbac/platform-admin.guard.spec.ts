import type { ExecutionContext } from '@nestjs/common';
import type { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAccessRequiredException } from './platform-admin.exception';

const USER_ID = '0191e3a0-8888-7000-8000-00000000000a';

function fakeTenantDb(platformRoleCode: string | null): TenantDb {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve([{ platformRoleCode }]),
  };
  return {
    transaction: (work: (tx: unknown) => unknown) => Promise.resolve(work(builder)),
  } as unknown as TenantDb;
}

const fakeContext = {} as unknown as ExecutionContext;
const passingJwtGuard = {
  canActivate: jest.fn().mockResolvedValue(true),
} as unknown as JwtAuthGuard;

/** Runs the guard inside the request scope and reports the resulting role before the scope closes. */
async function runAsUser(
  context: TenantContext,
  guard: PlatformAdminGuard,
): Promise<{ activated: boolean; role: string | undefined }> {
  return context.run({ userId: USER_ID }, async () => {
    const activated = await guard.canActivate(fakeContext);
    return { activated, role: context.current()?.role };
  });
}

describe('PlatformAdminGuard', () => {
  it('runs JwtAuthGuard first and rejects if it fails', async () => {
    const failingJwtGuard = {
      canActivate: jest.fn().mockRejectedValue(new Error('unauthenticated')),
    } as unknown as JwtAuthGuard;
    const context = new TenantContext();
    const guard = new PlatformAdminGuard(failingJwtGuard, fakeTenantDb('platform_admin'), context);

    await expect(runAsUser(context, guard)).rejects.toThrow('unauthenticated');
  });

  it.each(['platform_admin', 'platform_support', 'platform_finance'])(
    'accepts a %s and switches the context role to it',
    async (role) => {
      const context = new TenantContext();
      const guard = new PlatformAdminGuard(passingJwtGuard, fakeTenantDb(role), context);

      await expect(runAsUser(context, guard)).resolves.toEqual({ activated: true, role });
    },
  );

  it('rejects a user with no platform role', async () => {
    const context = new TenantContext();
    const guard = new PlatformAdminGuard(passingJwtGuard, fakeTenantDb(null), context);

    await expect(runAsUser(context, guard)).rejects.toBeInstanceOf(PlatformAccessRequiredException);
  });

  it('rejects an unrecognised platform role code (defence in depth)', async () => {
    const context = new TenantContext();
    const guard = new PlatformAdminGuard(passingJwtGuard, fakeTenantDb('made_up_role'), context);

    await expect(runAsUser(context, guard)).rejects.toBeInstanceOf(PlatformAccessRequiredException);
  });
});

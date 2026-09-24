import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import type { TenantDb } from '../database/tenant-db';
import { OwnershipGuard } from './ownership.guard';
import type { OwnershipSpec } from './ownership.metadata';
import { OwnershipRequiredException } from './rbac.exceptions';

const TENANT = '0191e3a0-cccc-7000-8000-00000000000a';
const MEMBER = '0191e3a0-cccc-7000-8000-00000000001a';
const POST_ID = '0191e3a0-cccc-7000-8000-00000000002a';

const SPEC: OwnershipSpec = { table: 'posts', ownerColumn: 'author_member_id', idParam: 'id' };

function fakeTenantDb(matches: boolean): TenantDb {
  return {
    transaction: (work: (tx: unknown) => unknown) =>
      Promise.resolve(work({ execute: () => Promise.resolve(matches ? [{ '?column?': 1 }] : []) })),
  } as unknown as TenantDb;
}

function fakeContextWithParams(params: Record<string, string>): ExecutionContext {
  const request = { params } as unknown as FastifyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(spec: OwnershipSpec | undefined, owns: boolean) {
  const reflector = { getAllAndOverride: () => spec } as unknown as Reflector;
  const context = new TenantContext();
  const guard = new OwnershipGuard(reflector, fakeTenantDb(owns), context);
  return { guard, context };
}

describe('OwnershipGuard', () => {
  it('passes routes with no @RequireOwnership metadata', async () => {
    const { guard, context } = buildGuard(undefined, false);
    await expect(context.run({}, () => guard.canActivate(fakeContextWithParams({})))).resolves.toBe(
      true,
    );
  });

  it('throws if there is no tenant/member context', async () => {
    const { guard, context } = buildGuard(SPEC, true);
    await expect(
      context.run({}, () => guard.canActivate(fakeContextWithParams({ id: POST_ID }))),
    ).rejects.toBeInstanceOf(TenantRequiredException);
  });

  it('throws if the route has no id param', async () => {
    const { guard, context } = buildGuard(SPEC, true);
    await expect(
      context.run({ tenantId: TENANT, memberId: MEMBER }, () =>
        guard.canActivate(fakeContextWithParams({})),
      ),
    ).rejects.toBeInstanceOf(OwnershipRequiredException);
  });

  it('denies when the row does not belong to the caller', async () => {
    const { guard, context } = buildGuard(SPEC, false);
    await expect(
      context.run({ tenantId: TENANT, memberId: MEMBER }, () =>
        guard.canActivate(fakeContextWithParams({ id: POST_ID })),
      ),
    ).rejects.toBeInstanceOf(OwnershipRequiredException);
  });

  it('allows when the row belongs to the caller', async () => {
    const { guard, context } = buildGuard(SPEC, true);
    await expect(
      context.run({ tenantId: TENANT, memberId: MEMBER }, () =>
        guard.canActivate(fakeContextWithParams({ id: POST_ID })),
      ),
    ).resolves.toBe(true);
  });
});

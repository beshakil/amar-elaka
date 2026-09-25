import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TenantGateGuard } from './tenant-gate.guard';
import {
  TenantIdInvalidException,
  TenantNotFoundException,
  TenantRequiredException,
  TenantSuspendedException,
  TenantTerminatedException,
} from './tenant.exceptions';
import type { ResolvedTenant, TenantResolutionOutcome } from './tenant-resolution.types';

function buildContext(outcome: TenantResolutionOutcome | undefined): ExecutionContext {
  // Where the middleware really puts it: on the raw Node request.
  const request = { raw: { tenantResolution: outcome } } as unknown as FastifyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(allowAnyTenant: boolean): TenantGateGuard {
  const reflector = { getAllAndOverride: () => allowAnyTenant } as unknown as Reflector;
  return new TenantGateGuard(reflector);
}

function tenant(statusCode: string): ResolvedTenant {
  return {
    id: '0191e3a0-7777-7000-8000-00000000000a',
    slug: 'mirpur',
    customDomain: null,
    statusCode,
  };
}

describe('TenantGateGuard', () => {
  describe('not allowlisted', () => {
    const guard = buildGuard(false);

    it('passes when resolved and active', () => {
      expect(guard.canActivate(buildContext({ kind: 'resolved', tenant: tenant('active') }))).toBe(
        true,
      );
    });

    it('passes when resolved and past_due (readable, only writes are blocked — a separate concern)', () => {
      expect(
        guard.canActivate(buildContext({ kind: 'resolved', tenant: tenant('past_due') })),
      ).toBe(true);
    });

    it('rejects a suspended tenant', () => {
      expect(() =>
        guard.canActivate(buildContext({ kind: 'resolved', tenant: tenant('suspended') })),
      ).toThrow(TenantSuspendedException);
    });

    it('rejects a terminated tenant', () => {
      expect(() =>
        guard.canActivate(buildContext({ kind: 'resolved', tenant: tenant('terminated') })),
      ).toThrow(TenantTerminatedException);
    });

    it('rejects an invalid X-Tenant-Id', () => {
      expect(() => guard.canActivate(buildContext({ kind: 'invalid_id' }))).toThrow(
        TenantIdInvalidException,
      );
    });

    it('rejects a not_found tenant', () => {
      expect(() => guard.canActivate(buildContext({ kind: 'not_found' }))).toThrow(
        TenantNotFoundException,
      );
    });

    it('rejects when nothing resolved at all', () => {
      expect(() => guard.canActivate(buildContext({ kind: 'none' }))).toThrow(
        TenantRequiredException,
      );
    });

    it('rejects when tenantResolution was never set (middleware not wired for some reason)', () => {
      expect(() => guard.canActivate(buildContext(undefined))).toThrow(TenantRequiredException);
    });
  });

  describe('@AllowAnyTenant()', () => {
    const guard = buildGuard(true);

    it.each(['active', 'past_due', 'suspended', 'terminated'] as const)(
      'passes regardless of status (%s)',
      (statusCode) => {
        expect(
          guard.canActivate(buildContext({ kind: 'resolved', tenant: tenant(statusCode) })),
        ).toBe(true);
      },
    );

    it('passes when unresolved', () => {
      expect(guard.canActivate(buildContext({ kind: 'none' }))).toBe(true);
    });

    it('passes even with an invalid id', () => {
      expect(guard.canActivate(buildContext({ kind: 'invalid_id' }))).toBe(true);
    });
  });
});

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { tenantResolutionOf } from './tenant-resolution.types';
import { ALLOW_ANY_TENANT_KEY } from './allow-any-tenant.decorator';
import {
  TenantIdInvalidException,
  TenantNotFoundException,
  TenantRequiredException,
  TenantSuspendedException,
  TenantTerminatedException,
} from './tenant.exceptions';

/**
 * The only place a request is rejected for tenant reasons. Reads what
 * TenantResolutionMiddleware found (`request.tenantResolution`) and the
 * route's `@AllowAnyTenant()` metadata (also implied by `@PlatformAdmin()`,
 * which sets the same key — platform routes are cross-tenant by nature).
 * Registered globally (APP_GUARD) in app.module.ts.
 */
@Injectable()
export class TenantGateGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowAnyTenant = this.reflector.getAllAndOverride<boolean>(ALLOW_ANY_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const outcome = tenantResolutionOf(request) ?? { kind: 'none' as const };

    if (allowAnyTenant) return true;

    switch (outcome.kind) {
      case 'resolved':
        if (outcome.tenant.statusCode === 'suspended') throw new TenantSuspendedException();
        if (outcome.tenant.statusCode === 'terminated') throw new TenantTerminatedException();
        return true;
      case 'invalid_id':
        throw new TenantIdInvalidException();
      case 'not_found':
        throw new TenantNotFoundException();
      case 'none':
        throw new TenantRequiredException();
    }
  }
}

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Reflector } from '@nestjs/core';
import { TenantContext } from '../../database/tenant-context';
import { BanStateService } from '../ban-state.service';
import { enforceBan } from './ban-enforcement';
import { TenantMismatchException, UnauthenticatedException } from '../exceptions/auth.exceptions';
import { TokenService } from '../tokens/token.service';
import { extractBearerToken } from './bearer-token';

/**
 * Same verification as JwtAuthGuard, but a missing Authorization header is
 * fine — the route runs anonymously instead. A *present but invalid* token
 * still fails loudly (a client that thinks it's linking an account
 * shouldn't silently fall back to an anonymous login attempt).
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly context: TenantContext,
    private readonly bans: BanStateService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearerToken(request);
    if (!token) {
      return true;
    }

    const claims = await this.tokens.verifyAccessToken(token).catch(() => {
      throw new UnauthenticatedException();
    });

    const currentTenantId = this.context.current()?.tenantId;
    if (currentTenantId !== undefined && currentTenantId !== claims.tenantId) {
      throw new TenantMismatchException();
    }

    // Bans bite on every request (ADR 063): one cached read per (user, area).
    const enforced = enforceBan(
      this.reflector,
      executionContext,
      claims,
      await this.bans.stateFor(claims.userId, claims.tenantId),
    );
    this.context.set({
      userId: claims.userId,
      tenantId: claims.tenantId,
      memberId: claims.memberId,
      role: enforced.role,
      ...(enforced.banAccess ? { banAccess: enforced.banAccess } : {}),
    });
    return true;
  }
}

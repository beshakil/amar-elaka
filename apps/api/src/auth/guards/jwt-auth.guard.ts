import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { TenantContext } from '../../database/tenant-context';
import { TenantMismatchException, UnauthenticatedException } from '../exceptions/auth.exceptions';
import { TokenService } from '../tokens/token.service';
import { extractBearerToken } from './bearer-token';

/**
 * Verifies the access JWT, checks its `tenantId` against whatever
 * TenantResolutionMiddleware already resolved for this request (a mismatch
 * means the token was issued for a different tenant — the client must
 * refresh against the right one), and populates TenantContext straight from
 * the token's claims. No DB round-trip: the token is short-lived (15m) and
 * self-contained by design (userId + tenantId + role + memberId).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly context: TenantContext,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthenticatedException();
    }

    const claims = await this.tokens.verifyAccessToken(token).catch(() => {
      throw new UnauthenticatedException();
    });

    const currentTenantId = this.context.current()?.tenantId;
    if (currentTenantId !== undefined && currentTenantId !== claims.tenantId) {
      throw new TenantMismatchException();
    }

    this.context.set({
      userId: claims.userId,
      tenantId: claims.tenantId,
      memberId: claims.memberId,
      role: claims.role,
    });
    return true;
  }
}

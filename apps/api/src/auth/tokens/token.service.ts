import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { parseDurationMs } from '../../common/utils/duration';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import type { AppRole } from '../../database/tenant-context';

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  memberId: string;
  role: AppRole;
  /** Present only on a banned account's token: exactly APPEAL_SCOPE (§9.10). */
  scope?: string[];
}

/** A banned session's whole world (schema.md §9.10). */
export const APPEAL_SCOPE: readonly string[] = ['appeal:read', 'appeal:write', 'account:read'];

export interface IssuedRefreshToken {
  token: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_REFRESH_TTL'>,
  ) {
    this.refreshTtlMs = parseDurationMs(env.JWT_REFRESH_TTL);
  }

  signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync({
      sub: claims.userId,
      tenantId: claims.tenantId,
      memberId: claims.memberId,
      role: claims.role,
      ...(claims.scope ? { scope: claims.scope } : {}),
    });
  }

  /** Throws JsonWebTokenError/TokenExpiredError from `jsonwebtoken` on failure — callers map those to typed exceptions. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const payload = await this.jwt.verifyAsync<{
      sub: string;
      tenantId: string;
      memberId: string;
      role: AppRole;
      scope?: string[];
    }>(token);
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      memberId: payload.memberId,
      role: payload.role,
      ...(Array.isArray(payload.scope) ? { scope: payload.scope } : {}),
    };
  }

  /** A brand-new rotation family — only ever called at login, never at refresh (rotation keeps the existing family). */
  issueRefreshToken(): IssuedRefreshToken {
    return {
      ...this.generateOpaqueToken(),
      familyId: randomUUID(),
      expiresAt: this.refreshTokenExpiresAt(),
    };
  }

  /** Just a fresh opaque token + its hash — used for rotation, where the family is preserved server-side. */
  generateOpaqueToken(): { token: string; tokenHash: string } {
    // settings-exempt: 256-bit token, a crypto sizing constant, not a business threshold.
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshTokenExpiresAt(): Date {
    return new Date(Date.now() + this.refreshTtlMs);
  }
}

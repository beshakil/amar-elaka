import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AppRole } from '../../database/tenant-context';
import { BAN_ACCESS_KEY, type BanAccess } from '../ban-access.decorator';
import type { BanState } from '../ban-state.service';
import {
  AccountBannedException,
  AccountRestrictedException,
  AccountTerminatedException,
  UnauthenticatedException,
} from '../exceptions/auth.exceptions';
import { APPEAL_SCOPE, type AccessTokenClaims } from '../tokens/token.service';

export interface Enforced {
  role: AppRole;
  banAccess: BanAccess | undefined;
}

/**
 * The request side of §9.10, one implementation for both JWT guards:
 *  - terminated: nothing (403 ACCOUNT_TERMINATED);
 *  - banned (or a token minted with the appeal-only scope): only routes
 *    marked @AppealAllowed(), and the database session runs as
 *    `restricted_user` (RLS: app_is_active_user() is false) — 403 ACCOUNT_BANNED otherwise;
 *  - an appeal-only token whose ban has ended: 401, so the client refreshes
 *    into a full session at once instead of waiting out the token;
 *  - restricted: everything but @ActiveAccountRequired() routes (posting,
 *    chat, reviews) — 403 ACCOUNT_RESTRICTED there.
 */
export function enforceBan(
  reflector: Reflector,
  executionContext: ExecutionContext,
  claims: AccessTokenClaims,
  state: BanState | null,
): Enforced {
  const access = reflector.getAllAndOverride<BanAccess | undefined>(BAN_ACCESS_KEY, [
    executionContext.getHandler(),
    executionContext.getClass(),
  ]);
  if (state?.severity === 'terminated') throw new AccountTerminatedException();
  const scopedToken = claims.scope?.join(' ') === APPEAL_SCOPE.join(' ');
  // The ban ended (appeal granted, lifted, expired) but this token was minted
  // under it: 401, so the client's refresh-on-401 mints a full one and replays.
  if (scopedToken && state?.severity !== 'banned') throw new UnauthenticatedException();
  if (state?.severity === 'banned' || scopedToken) {
    if (access !== 'appeal') throw new AccountBannedException();
    return { role: 'restricted_user', banAccess: access };
  }
  if (state?.severity === 'restricted' && access === 'active')
    throw new AccountRestrictedException();
  return { role: claims.role, banAccess: access };
}

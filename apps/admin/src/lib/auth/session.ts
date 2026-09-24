import { cookies } from 'next/headers';
import { env } from '../env';

export const ACCESS_TOKEN_COOKIE = 'ae_access';
export const REFRESH_TOKEN_COOKIE = 'ae_refresh';
export const TENANT_COOKIE = 'ae_tenant';

// The refresh token's own lifetime is the API's (JWT_REFRESH_TTL); this only
// bounds how long the browser keeps the cookie, so it is deliberately generous
// and the API still decides whether the token is actually valid.
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 60;

export interface Session {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
}

/**
 * Tokens live in httpOnly cookies set by this app's own route handlers, never
 * in client-readable storage: the API speaks bearer tokens only, so the browser
 * must never hold one where a script could read it. Every server-side call
 * reads them from here and forwards them as an Authorization header.
 */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_TOKEN_COOKIE)?.value;
  const tenantId = store.get(TENANT_COOKIE)?.value;
  if (!accessToken || !refreshToken || !tenantId) return null;
  return { accessToken, refreshToken, tenantId };
}

export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
} {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export { REFRESH_COOKIE_MAX_AGE };

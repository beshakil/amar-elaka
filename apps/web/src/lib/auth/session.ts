import { cookies } from 'next/headers';

export const ACCESS_TOKEN_COOKIE = 'ae_access';
export const REFRESH_TOKEN_COOKIE = 'ae_refresh';

// The refresh token's own lifetime is the API's (JWT_REFRESH_TTL); this only
// bounds how long the browser keeps the cookie, so it is deliberately generous
// and the API still decides whether the token is actually valid.
export const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 60;

export interface Session {
  accessToken: string;
  refreshToken: string;
}

/**
 * A seller's tokens live in httpOnly cookies set by this app's own route
 * handlers, never in client-readable storage (as in apps/admin). The cookies
 * are host-only: a session belongs to the area's own subdomain/domain, the
 * same tenant the token was issued for. The tenant itself comes from the
 * host (middleware.ts), not from the session.
 */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

/** Only a plain in-app path is followed after login — never one that leaves the site. */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : fallback;
}

import { NextResponse, type NextRequest } from 'next/server';
import { isAccessTokenExpired } from '@/lib/auth/jwt';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_MAX_AGE,
  REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from '@/lib/auth/session';

const LOGIN_PATH = '/login';
const REFRESH_TIMEOUT_MS = 5_000;

/**
 * Gates every dashboard route on a session cookie, and rotates an expired
 * access token on the way through so an operator is not bounced to the login
 * screen every fifteen minutes.
 *
 * This is a UX gate, not the security boundary: the API verifies the token on
 * every call regardless of what passes here.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const tenantId = request.cookies.get(TENANT_COOKIE)?.value;

  if (accessToken && !isAccessTokenExpired(accessToken)) {
    return NextResponse.next();
  }

  if (refreshToken && tenantId) {
    const rotation = await rotate(refreshToken, tenantId);
    if (rotation.kind === 'rotated') {
      const response = NextResponse.next();
      const options = {
        httpOnly: true as const,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
      };
      response.cookies.set(ACCESS_TOKEN_COOKIE, rotation.accessToken, options);
      response.cookies.set(REFRESH_TOKEN_COOKIE, rotation.refreshToken, {
        ...options,
        maxAge: REFRESH_COOKIE_MAX_AGE,
      });
      return response;
    }
    // The API could not be asked, so the refresh token is still unspent and
    // valid: keep the session and let the page report the outage (its own API
    // calls fail the same way, into the error boundary's retry). Logging the
    // operator out over a blip would throw away a perfectly good session.
    if (rotation.kind === 'unavailable') return NextResponse.next();
  }

  const login = new URL(LOGIN_PATH, request.url);
  login.searchParams.set('next', request.nextUrl.pathname);
  const redirect = NextResponse.redirect(login);
  // Refused, or never had one: the refresh token is spent, revoked or absent,
  // so clearing it avoids a loop of failing rotations.
  redirect.cookies.delete(ACCESS_TOKEN_COOKIE);
  redirect.cookies.delete(REFRESH_TOKEN_COOKIE);
  return redirect;
}

type Rotation =
  | { kind: 'rotated'; accessToken: string; refreshToken: string }
  /** The API answered no: expired, revoked, or a replay of a spent token. */
  | { kind: 'refused' }
  /** The API could not answer: down, timed out, or a 5xx. */
  | { kind: 'unavailable' };

async function rotate(refreshToken: string, tenantId: string): Promise<Rotation> {
  try {
    const response = await fetch(`${process.env.API_BASE_URL ?? ''}/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (response.status >= 500) return { kind: 'unavailable' };
    if (!response.ok) return { kind: 'refused' };

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return { kind: 'refused' };
    const { accessToken, refreshToken: next } = body as Record<string, unknown>;
    return typeof accessToken === 'string' && typeof next === 'string'
      ? { kind: 'rotated', accessToken, refreshToken: next }
      : { kind: 'refused' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export const config = {
  // Everything except the login screen, this app's own auth endpoints and
  // static assets. Route handlers under /api/auth must stay open: that is where
  // a session is created in the first place.
  matcher: ['/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)'],
};

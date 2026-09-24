import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { readSession, ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@/lib/auth/session';

/**
 * Revokes the refresh token server-side, then clears the cookies. The tenant
 * cookie stays: it is only a preference, and keeping it means the login form
 * comes back with the right area preselected.
 */
export async function POST(): Promise<NextResponse> {
  const session = await readSession();

  if (session) {
    await apiFetch({
      path: '/auth/logout',
      method: 'POST',
      schema: z.unknown(),
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      body: { refreshToken: session.refreshToken },
      // A failed revoke must not strand the operator in a logged-in UI; the
      // cookies are cleared either way and the token expires on its own.
    }).catch(() => undefined);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
  return response;
}

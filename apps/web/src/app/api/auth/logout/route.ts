import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, readSession } from '@/lib/auth/session';
import { currentTenantId } from '@/lib/tenant';

/** Revokes the refresh token at the API (best effort) and always clears the cookies. */
export async function POST(): Promise<NextResponse> {
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (session && tenantId) {
    await apiFetch({
      path: '/auth/logout',
      method: 'POST',
      schema: z.unknown(),
      tenantId,
      accessToken: session.accessToken,
      body: { refreshToken: session.refreshToken },
    }).catch(() => undefined);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
  return response;
}

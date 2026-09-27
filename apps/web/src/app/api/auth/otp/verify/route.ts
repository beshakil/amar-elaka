import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { sessionTokensSchema } from '@/lib/api/schemas';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_MAX_AGE,
  REFRESH_TOKEN_COOKIE,
  sessionCookieOptions,
} from '@/lib/auth/session';
import { currentTenantId } from '@/lib/tenant';

const bodySchema = z.object({ phone: z.string().trim().min(1), code: z.string().trim().min(1) });

/**
 * Exchanges the SMS code for a token pair and puts it straight into httpOnly
 * cookies: the browser never holds a token (as in apps/admin). The token is
 * issued for the tenant of this host.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'OTP_INCORRECT' }, { status: 400 });
  const tenantId = await currentTenantId();
  if (!tenantId) return NextResponse.json({ code: 'TENANT_REQUIRED' }, { status: 400 });
  try {
    const tokens = await apiFetch({
      path: '/auth/otp/verify',
      method: 'POST',
      schema: sessionTokensSchema,
      tenantId,
      body: { ...parsed.data, device: { platformCode: 'web' } },
    });
    const response = NextResponse.json({ ok: true });
    const options = sessionCookieOptions();
    response.cookies.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, options);
    response.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...options,
      maxAge: REFRESH_COOKIE_MAX_AGE,
    });
    return response;
  } catch (error) {
    return routeError(error);
  }
}

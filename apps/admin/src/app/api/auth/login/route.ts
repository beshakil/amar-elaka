import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch, ApiError, ApiUnreachableError } from '@/lib/api/fetch';
import { sessionTokensSchema } from '@/lib/api/schemas';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_MAX_AGE,
  REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
  sessionCookieOptions,
} from '@/lib/auth/session';

const loginSchema = z.object({
  tenantId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * The browser never sees a token: it posts credentials here, this exchanges
 * them with the API for a bearer pair, and the pair goes straight into httpOnly
 * cookies. The tenant is chosen at login because the API issues a token scoped
 * to one tenant, and the dashboard operates on that tenant.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: 'INVALID_INPUT' }, { status: 400 });
  }

  const { tenantId, email, password } = parsed.data;

  try {
    const tokens = await apiFetch({
      path: '/auth/email/login',
      method: 'POST',
      schema: sessionTokensSchema,
      tenantId,
      body: { email, password, device: { platformCode: 'web' } },
    });

    const response = NextResponse.json({ ok: true });
    const options = sessionCookieOptions();
    response.cookies.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, options);
    response.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...options,
      maxAge: REFRESH_COOKIE_MAX_AGE,
    });
    response.cookies.set(TENANT_COOKIE, tenantId, { ...options, maxAge: REFRESH_COOKIE_MAX_AGE });
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ code: error.code }, { status: error.status });
    }
    if (error instanceof ApiUnreachableError) {
      return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 503 });
    }
    throw error;
  }
}

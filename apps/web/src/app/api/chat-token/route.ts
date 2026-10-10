import { NextResponse, type NextRequest } from 'next/server';
import { accessTokenExpiresAt } from '@/lib/auth/jwt';
import { readSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { currentOrigin } from '@/lib/tenant';

/**
 * The chat socket's credentials for this browser (ADR 060). The session stays
 * in httpOnly cookies; the socket (a direct connection to the API, which a
 * cookie can't reach) gets only the short-lived access token, asked for at
 * every (re)connect. middleware.ts has already rotated an expired token on
 * the way here, as for any signed-in page. Same-origin only, never cached.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = await currentOrigin();
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return new NextResponse(null, { status: 403 });
  const from = request.headers.get('origin');
  if (from !== null && from !== origin) return new NextResponse(null, { status: 403 });

  const session = await readSession();
  if (!session) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401, headers: noStore });
  }
  const expiresAt = accessTokenExpiresAt(session.accessToken);
  return NextResponse.json(
    {
      token: session.accessToken,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      socketUrl: env().CHAT_SOCKET_URL ?? new URL(env().API_BASE_URL).origin,
    },
    { headers: noStore },
  );
}

const noStore = { 'Cache-Control': 'no-store' };

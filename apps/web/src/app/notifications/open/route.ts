import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { readSession } from '@/lib/auth/session';
import { webPathForDeepLink } from '@/lib/notifications/links';
import { currentOrigin, currentTenantId } from '@/lib/tenant';

/**
 * Where a clicked web push (or a notification in the list) goes (ADR 060):
 * marked read, then the exact page for its deep link — the conversation for
 * a chat — or the notification page when the site has none. Only ever a
 * path of this site (webPathForDeepLink), never an open redirect.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = await currentOrigin();
  const link = request.nextUrl.searchParams.get('link');
  const id = z.string().uuid().safeParse(request.nextUrl.searchParams.get('id'));
  if (id.success) {
    const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
    if (session && tenantId) {
      await apiFetch({
        path: `/notifications/${id.data}/read`,
        method: 'POST',
        schema: z.null(),
        tenantId,
        accessToken: session.accessToken,
      }).catch(() => undefined);
    }
  }
  return NextResponse.redirect(new URL(webPathForDeepLink(link) ?? '/notifications', origin), 303);
}

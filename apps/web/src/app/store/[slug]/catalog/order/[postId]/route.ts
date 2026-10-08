import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { apiFetch } from '@/lib/api/fetch';
import { contactRevealSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { installId, rememberInstallId, visitorHeaders } from '@/lib/listings/visitor';
import { currentOrigin, currentTenantId } from '@/lib/tenant';

const paramsSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  postId: z.string().uuid(),
});

/** The API's refusals → the catalog page's ?order= notice. */
const REFUSALS: Record<string, string> = {
  CONTACT_LIMIT_REACHED: 'limit',
  CONTACT_CHANNEL_UNAVAILABLE: 'off',
  CONTACT_OWN_STORE: 'own',
  POST_NOT_FOUND: 'gone',
};

/**
 * "WhatsApp-এ অর্ডার" from the catalog page (ADR 056), a plain form post so
 * it works without JavaScript and no link prefetcher or crawler ever makes a
 * lead. The same POST /stores/:slug/catalog/order/:postId as the app — the
 * lead, the daily limit, the sign-in rule — made with the visitor's session
 * and browser id; the number only ever leaves in the redirect to wa.me.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; postId: string }> },
): Promise<NextResponse> {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return new NextResponse(null, { status: 404 });
  const { slug, postId } = parsed.data;
  const origin = await currentOrigin();
  // A form on another site can't spend this visitor's contact allowance.
  const from = request.headers.get('origin');
  if (from !== null && from !== new URL(origin).origin)
    return new NextResponse(null, { status: 403 });

  const catalog = `/store/${slug}/catalog`;
  const back = (flag: string) =>
    NextResponse.redirect(new URL(`${catalog}?order=${flag}#p-${postId}`, origin), 303);
  const install = installId(request);
  let response: NextResponse;
  try {
    const session = await readSession();
    const reveal = await apiFetch({
      path: `/stores/${slug}/catalog/order/${postId}`,
      method: 'POST',
      schema: contactRevealSchema,
      tenantId: (await currentTenantId()) ?? undefined,
      accessToken: session?.accessToken,
      headers: visitorHeaders(request, install.id),
    });
    response = NextResponse.redirect(reveal.href, 303);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === 'CONTACT_LOGIN_REQUIRED' || error.status === 401)
    ) {
      response = NextResponse.redirect(
        new URL(`/login?next=${encodeURIComponent(catalog)}`, origin),
        303,
      );
    } else if (error instanceof ApiError && error.status === 404) {
      response = back('gone');
    } else {
      response = back((error instanceof ApiError && REFUSALS[error.code]) || 'failed');
    }
  }
  response.headers.set('Cache-Control', 'no-store');
  if (install.isNew) rememberInstallId(response, install.id);
  return response;
}

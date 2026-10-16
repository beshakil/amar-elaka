import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { contactRevealSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { installId, rememberInstallId, visitorHeaders } from '@/lib/listings/visitor';
import { currentTenantId } from '@/lib/tenant';

const bodySchema = z.object({ channel: z.enum(['call', 'whatsapp', 'sms']) }).strict();
const idSchema = z.string().uuid();

/**
 * A lost & found reporter's number (ADR 065): the same
 * POST /info/lost-found/:id/contact as the app — a lead, the daily limit,
 * sign-in — made here with the visitor's session. The number exists only
 * in this response, never in the page.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const id = idSchema.safeParse((await params).id);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) {
    return NextResponse.json({ code: 'VALIDATION_FAILED' }, { status: 400 });
  }
  const session = await readSession();
  if (!session) return NextResponse.json({ code: 'CONTACT_LOGIN_REQUIRED' }, { status: 401 });
  const install = installId(request);
  try {
    const reveal = await apiFetch({
      path: `/info/lost-found/${id.data}/contact`,
      method: 'POST',
      body: body.data,
      schema: contactRevealSchema,
      tenantId: (await currentTenantId()) ?? undefined,
      accessToken: session.accessToken,
      headers: visitorHeaders(request, install.id),
    });
    const response = NextResponse.json(reveal, { headers: { 'Cache-Control': 'no-store' } });
    if (install.isNew) rememberInstallId(response, install.id);
    return response;
  } catch (error) {
    return routeError(error);
  }
}

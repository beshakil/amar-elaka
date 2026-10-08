import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { saveResultSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { currentOrigin, currentTenantId } from '@/lib/tenant';

const idSchema = z.string().uuid();

/**
 * "সেভ করুন" on a listing page (ADR 037): the app's POST /saved/post/:id,
 * made by this server with the visitor's session. 401 `LOGIN_REQUIRED`
 * without one (the button sends them to login and back).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Only this site's own pages: a cross-site POST gets nothing done.
  const from = request.headers.get('origin');
  if (from !== null && from !== (await currentOrigin())) {
    return new NextResponse(null, { status: 403 });
  }
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ code: 'VALIDATION_FAILED' }, { status: 400 });
  const session = await readSession();
  if (!session) return NextResponse.json({ code: 'LOGIN_REQUIRED' }, { status: 401 });
  try {
    const result = await apiFetch({
      path: `/saved/post/${id.data}`,
      method: 'POST',
      schema: saveResultSchema,
      tenantId: (await currentTenantId()) ?? undefined,
      accessToken: session.accessToken,
    });
    return NextResponse.json(
      { created: result.created },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return routeError(error);
  }
}

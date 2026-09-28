import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { readSession } from '@/lib/auth/session';
import { installId, rememberInstallId, visitorHeaders } from '@/lib/listings/visitor';
import { currentTenantId } from '@/lib/tenant';

/**
 * A listing view (navigator.sendBeacon from the page): POST /posts/:id/view
 * with the visitor's browser id, so the API counts each browser once per
 * window. Always 204 — a failed count must never bother the visitor.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  const response = new NextResponse(null, { status: 204 });
  if (!id.success) return response;
  const install = installId(request);
  try {
    const session = await readSession();
    await apiFetch({
      path: `/posts/${id.data}/view`,
      method: 'POST',
      schema: z.null(),
      tenantId: (await currentTenantId()) ?? undefined,
      accessToken: session?.accessToken,
      headers: visitorHeaders(request, install.id),
    });
  } catch {
    // Not counted this time; nothing to show.
  }
  if (install.isNew) rememberInstallId(response, install.id);
  return response;
}

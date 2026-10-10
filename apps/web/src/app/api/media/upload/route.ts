import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeError } from '@/lib/api/route-errors';
import { readSession } from '@/lib/auth/session';
import { ACCEPTED_IMAGE_TYPES } from '@/lib/media/compress-image';
import { uploadThroughApi } from '@/lib/media/server-upload';
import { currentTenantId } from '@/lib/tenant';

// Transport tuning, not a business rule (the API owns the real upload limit,
// media_max_upload_bytes, and refuses at presign): a body cap so this server
// never buffers something absurd.
const MAX_BODY_BYTES = 15 * 1024 * 1024;

/**
 * One photo, uploaded in one browser request: the browser sends the
 * compressed image here (same origin, so no CORS and no token in the
 * browser), and this server does the rest with the seller's session —
 *
 *   presign (POST /media/presign) → PUT to the presigned URL the API just
 *   issued → confirm → wait until the worker has made it `ready`
 *
 * — so a photo reported done is one a post can attach (the API refuses
 * photos still `processing`). Never an open proxy: the only URL this
 * forwards to is the one the API returned a moment ago.
 *
 * `?conversation=<id>`: a photo for that chat (ADR 060), through the
 * conversation's own image endpoints — the API checks the sender is in it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  const sha256 = request.headers.get('x-content-sha256') ?? '';
  const conversation = request.nextUrl.searchParams.get('conversation');
  if (
    !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(contentType) ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    (conversation !== null && !z.string().uuid().safeParse(conversation).success)
  ) {
    return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 400 });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES)
    return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 413 });

  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  if (!tenantId) return NextResponse.json({ code: 'TENANT_REQUIRED' }, { status: 400 });
  const auth = { tenantId, accessToken: session.accessToken };

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 413 });
  }

  try {
    const result = await uploadThroughApi(auth, {
      kind: 'image',
      contentType,
      bytes: body,
      sha256,
      conversationId: conversation ?? undefined,
    });
    return result.ok
      ? NextResponse.json({ mediaId: result.mediaId })
      : NextResponse.json({ code: result.code }, { status: result.status });
  } catch (error) {
    return routeError(error);
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { apiFetch } from '@/lib/api/fetch';
import { routeError } from '@/lib/api/route-errors';
import { mediaStatusSchema, presignedMediaSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { ACCEPTED_IMAGE_TYPES } from '@/lib/media/compress-image';
import { currentTenantId } from '@/lib/tenant';

// Transport tuning, not business rules (the API owns the real upload limit,
// media_max_upload_bytes, and refuses at presign): a body cap so this server
// never buffers something absurd, and how long to wait for the worker to make
// a confirmed photo ready.
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const PUT_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
const READY_MAX_POLLS = 40;

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
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  const sha256 = request.headers.get('x-content-sha256') ?? '';
  if (
    !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(contentType) ||
    !/^[0-9a-f]{64}$/.test(sha256)
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
    const presigned = await apiFetch({
      path: '/media/presign',
      method: 'POST',
      schema: presignedMediaSchema,
      ...auth,
      body: { kind: 'image', contentType, byteSize: body.byteLength, checksumSha256: sha256 },
    });

    const put = await fetch(presigned.upload.url, {
      method: 'PUT',
      headers: presigned.upload.headers,
      body,
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    }).catch(() => null);
    if (!put?.ok) {
      const retryable = !put || put.status >= 500;
      return NextResponse.json(
        { code: retryable ? 'NETWORK' : 'UPLOAD_REJECTED' },
        { status: retryable ? 503 : 400 },
      );
    }

    let status = await apiFetch({
      path: `/media/${presigned.id}/confirm`,
      method: 'POST',
      schema: mediaStatusSchema,
      ...auth,
    });
    for (let poll = 0; status.status === 'processing' && poll < READY_MAX_POLLS; poll++) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      status = await apiFetch({
        path: `/media/${presigned.id}`,
        schema: mediaStatusSchema,
        ...auth,
      });
    }
    if (status.status === 'ready') return NextResponse.json({ mediaId: presigned.id });
    if (status.status === 'processing') {
      // Taking unusually long: worth another try later, not a refused photo.
      return NextResponse.json({ code: 'PROCESSING_TIMEOUT' }, { status: 503 });
    }
    return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 422 });
  } catch (error) {
    return routeError(error);
  }
}

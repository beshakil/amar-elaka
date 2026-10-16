import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import { mediaStatusSchema, presignedMediaSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

// Transport tuning, not business rules (the API owns the upload limits and
// refuses at presign): a body cap so this server never buffers something
// absurd, how long the PUT may take, how long to wait for `ready`.
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const PUT_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
const READY_MAX_POLLS = 40;

/** A photo goes through the image pipeline (public); a PDF is a private document. */
const KIND_OF: Record<string, 'image' | 'document'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'document',
};

/**
 * A notice's attachment (ADR 065), uploaded by this server with the
 * partner's session: presign → PUT to the URL the API just issued → confirm
 * → wait until `ready`. Never an open proxy: the only URL it sends to is the
 * one the API returned a moment ago.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  const kind = KIND_OF[contentType];
  if (!kind) return NextResponse.json({ messageKey: 'validationFailed' }, { status: 400 });
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
    return NextResponse.json({ messageKey: 'validationFailed' }, { status: 413 });
  }
  const session = await readSession();
  if (!session) return NextResponse.json({ messageKey: 'unauthenticated' }, { status: 401 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ messageKey: 'validationFailed' }, { status: 413 });
  }
  const auth = { tenantId: session.tenantId, accessToken: session.accessToken };
  try {
    const presigned = await apiFetch({
      path: '/media/presign',
      method: 'POST',
      schema: presignedMediaSchema,
      ...auth,
      body: {
        kind,
        contentType,
        byteSize: bytes.byteLength,
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    const put = await fetch(presigned.upload.url, {
      method: 'PUT',
      headers: presigned.upload.headers,
      body: bytes,
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    }).catch(() => null);
    if (!put?.ok) return NextResponse.json({ messageKey: 'unreachable' }, { status: 503 });
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
    return status.status === 'ready'
      ? NextResponse.json({ mediaId: presigned.id, kind })
      : NextResponse.json({ messageKey: 'validationFailed' }, { status: 422 });
  } catch (error) {
    return NextResponse.json({ messageKey: apiErrorMessageKey(error) }, { status: 502 });
  }
}

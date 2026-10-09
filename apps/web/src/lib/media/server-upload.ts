import { apiFetch } from '../api/fetch';
import { mediaStatusSchema, presignedMediaSchema } from '../api/schemas';

// Transport tuning, not business rules (the API owns the real upload limits
// and refuses at presign): how long the PUT may take, and how long to wait
// for the worker to make a confirmed file ready.
const PUT_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
const READY_MAX_POLLS = 40;

export type ServerUploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; code: 'NETWORK' | 'UPLOAD_REJECTED' | 'PROCESSING_TIMEOUT'; status: number };

/**
 * One file, uploaded by this server with the seller's session (ADR 036/057):
 * presign → PUT to the URL the API just issued → confirm (the API checks the
 * bytes) → wait until it is `ready`. Never an open proxy: the only URL it
 * sends to is the one the API returned a moment ago. API errors throw (the
 * caller's routeError turns them into a response).
 */
export async function uploadThroughApi(
  auth: { tenantId: string; accessToken: string },
  file: {
    kind: 'image' | 'import';
    contentType: string;
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
  },
): Promise<ServerUploadResult> {
  const presigned = await apiFetch({
    path: '/media/presign',
    method: 'POST',
    schema: presignedMediaSchema,
    ...auth,
    body: {
      kind: file.kind,
      contentType: file.contentType,
      byteSize: file.bytes.byteLength,
      checksumSha256: file.sha256,
    },
  });

  const put = await fetch(presigned.upload.url, {
    method: 'PUT',
    headers: presigned.upload.headers,
    body: file.bytes,
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  }).catch(() => null);
  if (!put?.ok) {
    const retryable = !put || put.status >= 500;
    return retryable
      ? { ok: false, code: 'NETWORK', status: 503 }
      : { ok: false, code: 'UPLOAD_REJECTED', status: 400 };
  }

  let status = await apiFetch({
    path: `/media/${presigned.id}/confirm`,
    method: 'POST',
    schema: mediaStatusSchema,
    ...auth,
  });
  for (let poll = 0; status.status === 'processing' && poll < READY_MAX_POLLS; poll++) {
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    status = await apiFetch({ path: `/media/${presigned.id}`, schema: mediaStatusSchema, ...auth });
  }
  if (status.status === 'ready') return { ok: true, mediaId: presigned.id };
  // Taking unusually long: worth another try later, not a refused file.
  if (status.status === 'processing') return { ok: false, code: 'PROCESSING_TIMEOUT', status: 503 };
  return { ok: false, code: 'UPLOAD_REJECTED', status: 422 };
}

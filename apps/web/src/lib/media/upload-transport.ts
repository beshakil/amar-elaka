/**
 * How the uploader reaches the API and storage. The bytes never pass through
 * the API: `presign` and `confirm` carry only metadata, and `put` sends the
 * file from the browser straight to the presigned storage URL.
 */

export interface PresignedTarget {
  mediaId: string;
  url: string;
  /** Headers the URL was signed with (Content-Type, Content-Length). */
  headers: Record<string, string>;
}

export interface PresignInput {
  byteSize: number;
  sha256: string;
  contentType: string;
}

export interface UploadTransport {
  presign(input: PresignInput): Promise<PresignedTarget>;
  put(
    target: PresignedTarget,
    body: Blob,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  confirm(mediaId: string): Promise<void>;
}

/** A failed step. `code` is the API's error code, or network/timeout/cancelled. */
export class UploadFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`upload failed: ${code}`);
    this.name = 'UploadFailure';
  }
}

/**
 * Worth retrying: no answer, a server error, the rate limit, a conflict
 * (confirm before the PUT is visible) and 403 (an expired signature — the
 * retry presigns again). Anything else means the file itself was refused.
 */
export function failureFromStatus(status: number, code: string): UploadFailure {
  const retryable = status === 0 || status >= 500 || [403, 409, 429].includes(status);
  return new UploadFailure(code, retryable);
}

// Transport tuning, not a business rule: a ~150 KB compressed photo on a slow
// mobile connection. The API owns every real limit via platform_settings.
const PUT_TIMEOUT_MS = 60_000;

/**
 * PUT to storage with upload progress — which `fetch` can't report, hence XHR.
 * Content-Length is set by the browser from the body (it may not be set by
 * script); it matches the signed value because the body is the same blob.
 */
export function xhrPut(
  target: PresignedTarget,
  body: Blob,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadFailure('cancelled', false));
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url);
    xhr.timeout = PUT_TIMEOUT_MS;
    for (const [name, value] of Object.entries(target.headers)) {
      if (name.toLowerCase() !== 'content-length') xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(failureFromStatus(xhr.status, `STORAGE_${xhr.status}`));
    xhr.onerror = () => reject(new UploadFailure('network', true));
    xhr.ontimeout = () => reject(new UploadFailure('timeout', true));
    xhr.onabort = () => reject(new UploadFailure('cancelled', false));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * What a server action returns across the network boundary. Next.js hides a
 * thrown error's details from the browser in production, so the API's status
 * and code travel as data instead.
 */
export type MediaActionResult<T> =
  { ok: true; data: T } | { ok: false; status: number; code: string };

export interface MediaActions {
  presign(
    input: PresignInput,
  ): Promise<
    MediaActionResult<{ id: string; upload: { url: string; headers: Record<string, string> } }>
  >;
  confirm(mediaId: string): Promise<MediaActionResult<unknown>>;
}

/**
 * The real transport: presign and confirm through server actions (which call
 * the API with the signed-in user's token), PUT straight to storage.
 */
export function createApiUploadTransport(actions: MediaActions): UploadTransport {
  const unwrap = async <T>(call: Promise<MediaActionResult<T>>): Promise<T> => {
    let result: MediaActionResult<T>;
    try {
      result = await call;
    } catch {
      throw new UploadFailure('network', true);
    }
    if (!result.ok) throw failureFromStatus(result.status, result.code);
    return result.data;
  };
  return {
    async presign(input) {
      const { id, upload } = await unwrap(actions.presign(input));
      return { mediaId: id, url: upload.url, headers: upload.headers };
    },
    put: xhrPut,
    async confirm(mediaId) {
      await unwrap(actions.confirm(mediaId));
    },
  };
}

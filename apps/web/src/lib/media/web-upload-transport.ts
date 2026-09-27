import { UploadFailure, type UploadTransport } from './upload-transport';

const UPLOAD_PATH = '/api/media/upload';

/**
 * The real transport for the browser: each photo goes to this app's own
 * /api/media/upload in one request, which presigns, stores, confirms and
 * waits until it's ready (app/api/media/upload/route.ts). So `presign` is
 * local, `put` does the trip — with upload progress — and returns the media
 * id, and `confirm` has nothing left to do.
 */
export function createWebUploadTransport(): UploadTransport {
  return {
    presign: ({ sha256, contentType }) =>
      Promise.resolve({
        mediaId: '',
        url: UPLOAD_PATH,
        headers: { 'content-type': contentType, 'x-content-sha256': sha256 },
      }),
    put: (target, body, onProgress, signal) =>
      new Promise<{ mediaId: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', target.url);
        for (const [name, value] of Object.entries(target.headers))
          xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          const payload: unknown = (() => {
            try {
              return JSON.parse(xhr.responseText) as unknown;
            } catch {
              return null;
            }
          })();
          const record =
            typeof payload === 'object' && payload !== null
              ? (payload as Record<string, unknown>)
              : {};
          if (xhr.status >= 200 && xhr.status < 300 && typeof record.mediaId === 'string') {
            resolve({ mediaId: record.mediaId });
            return;
          }
          const code = typeof record.code === 'string' ? record.code : 'UPLOAD_FAILED';
          // A refused photo fails at once; our/their outage is retried.
          reject(new UploadFailure(code, xhr.status >= 500 || xhr.status === 429));
        };
        xhr.onerror = () => reject(new UploadFailure('network', true));
        xhr.ontimeout = () => reject(new UploadFailure('timeout', true));
        signal.addEventListener('abort', () => {
          xhr.abort();
          reject(new UploadFailure('cancelled', false));
        });
        xhr.send(body);
      }),
    confirm: () => Promise.resolve(),
  };
}

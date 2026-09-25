import { UploadFailure, type UploadTransport } from './upload-transport';

/**
 * Dev preview only: pretends to upload, with visible progress, and fails the
 * 3rd and 6th uploads once each so retry is exercised. Nothing leaves the page.
 */
export function createSimulatedTransport(stepMs = 120): UploadTransport {
  let presigned = 0;
  let puts = 0;
  const failedOnce = new Set<number>();
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new UploadFailure('cancelled', false));
        },
        { once: true },
      );
    });

  return {
    async presign() {
      await wait(stepMs);
      presigned += 1;
      return { mediaId: `preview-${presigned}`, url: 'about:blank', headers: {} };
    },
    async put(_target, _body, onProgress, signal) {
      puts += 1;
      const n = puts;
      for (let step = 1; step <= 10; step++) {
        await wait(stepMs, signal);
        onProgress(step / 10);
        if (step === 6 && (n === 3 || n === 6) && !failedOnce.has(n)) {
          failedOnce.add(n);
          throw new UploadFailure('network', true);
        }
      }
    },
    async confirm() {
      await wait(stepMs);
    },
  };
}

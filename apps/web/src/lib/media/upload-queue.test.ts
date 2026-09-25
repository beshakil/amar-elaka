import { describe, expect, it } from 'vitest';
import { fitWithin, isAcceptedImage } from './compress-image';
import { DEFAULT_RETRY_DELAYS_MS, UploadQueue, sha256Hex } from './upload-queue';
import {
  UploadFailure,
  createApiUploadTransport,
  failureFromStatus,
  type PresignedTarget,
  type UploadTransport,
} from './upload-transport';

class FakeTransport implements UploadTransport {
  putFailures: (UploadFailure | null)[] = [];
  confirmed: string[] = [];
  presigned: { byteSize: number; sha256: string; contentType: string }[] = [];
  active = 0;
  maxActive = 0;
  gate: Promise<void> = Promise.resolve();

  presign(input: { byteSize: number; sha256: string; contentType: string }) {
    this.presigned.push(input);
    const n = this.presigned.length;
    return Promise.resolve({ mediaId: `m${n}`, url: `https://storage.test/${n}`, headers: {} });
  }

  async put(
    _target: PresignedTarget,
    _body: Blob,
    onProgress: (f: number) => void,
    signal: AbortSignal,
  ) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await this.gate;
      await Promise.resolve();
      if (signal.aborted) throw new UploadFailure('cancelled', false);
      const failure = this.putFailures.shift();
      if (failure) throw failure;
      onProgress(0.5);
      onProgress(1);
    } finally {
      this.active--;
    }
  }

  confirm(mediaId: string) {
    this.confirmed.push(mediaId);
    return Promise.resolve();
  }
}

const photo = (name: string) => new Blob([name], { type: 'image/jpeg' });
const webp = (source: Blob) =>
  Promise.resolve(new Blob(['compressed:', source], { type: 'image/webp' }));

function setup(transport = new FakeTransport(), compress = webp) {
  const delays: number[] = [];
  let ids = 0;
  const queue = new UploadQueue({
    transport,
    compress,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    newId: () => `item${++ids}`,
  });
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      if (queue.getSnapshot().every((it) => it.status === 'done' || it.status === 'failed')) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { queue, transport, delays, settled };
}

describe('UploadQueue', () => {
  it('compresses, hashes, uploads and confirms, two at a time', async () => {
    const { queue, transport, settled } = setup();
    const notified: number[] = [];
    queue.subscribe(() => notified.push(queue.getSnapshot().length));
    expect(queue.add([photo('a'), photo('b'), photo('c')])).toBe(3);
    await settled();

    expect(queue.getSnapshot().map((i) => i.status)).toEqual(['done', 'done', 'done']);
    expect(queue.mediaIds).toHaveLength(3);
    expect(queue.isComplete).toBe(true);
    expect(transport.maxActive).toBeLessThanOrEqual(2);
    expect(transport.presigned[0]).toMatchObject({ contentType: 'image/webp' });
    expect(transport.presigned[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(notified.length).toBeGreaterThan(3);
  });

  it('retries a retryable failure with backoff, reusing the compressed file', async () => {
    const transport = new FakeTransport();
    transport.putFailures = [new UploadFailure('network', true)];
    let compressions = 0;
    const { queue, delays, settled } = setup(transport, (f) => {
      compressions++;
      return webp(f);
    });
    queue.add([photo('a')]);
    await settled();

    expect(queue.getSnapshot()[0]).toMatchObject({ status: 'done', attempts: 1 });
    expect(delays).toEqual([DEFAULT_RETRY_DELAYS_MS[0]]);
    expect(compressions).toBe(1);
  });

  it('fails after the last retry, and a manual retry starts over', async () => {
    const transport = new FakeTransport();
    transport.putFailures = Array.from({ length: 4 }, () => new UploadFailure('timeout', true));
    const { queue, delays, settled } = setup(transport);
    queue.add([photo('a')]);
    await settled();
    expect(queue.getSnapshot()[0]).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(delays).toEqual([...DEFAULT_RETRY_DELAYS_MS]);

    queue.retry('item1');
    await settled();
    expect(queue.getSnapshot()[0]!.status).toBe('done');
  });

  it('fails at once when the file is refused, or cannot be decoded', async () => {
    const transport = new FakeTransport();
    transport.putFailures = [failureFromStatus(422, 'UPLOAD_REJECTED')];
    const { queue, delays, settled } = setup(transport, (f) =>
      (f as Blob & { size: number }).size === 3 ? Promise.reject(new Error('corrupt')) : webp(f),
    );
    queue.add([photo('a'), photo('bad')]);
    await settled();
    expect(queue.getSnapshot().map((i) => [i.status, i.errorCode])).toEqual([
      ['failed', 'UPLOAD_REJECTED'],
      ['failed', 'compression'],
    ]);
    expect(delays).toEqual([]);
  });

  it('caps the queue at 10 photos', () => {
    const { queue } = setup();
    expect(queue.add(Array.from({ length: 12 }, (_, i) => photo(String(i))))).toBe(10);
    expect(queue.remainingSlots).toBe(0);
    expect(queue.add([photo('x')])).toBe(0);
    queue.dispose();
  });

  it('reorders, and removing an item aborts its upload', async () => {
    const transport = new FakeTransport();
    let open!: () => void;
    transport.gate = new Promise((r) => (open = r));
    const { queue, settled } = setup(transport);
    queue.add([photo('a'), photo('b'), photo('c')]);
    await new Promise((r) => setTimeout(r, 0));

    queue.reorder(2, 0);
    expect(queue.getSnapshot().map((i) => i.id)).toEqual(['item3', 'item1', 'item2']);
    queue.reorder(0, 2);
    expect(queue.getSnapshot().map((i) => i.id)).toEqual(['item1', 'item2', 'item3']);
    queue.reorder(0, 5); // out of range: ignored
    expect(queue.getSnapshot().map((i) => i.id)).toEqual(['item1', 'item2', 'item3']);

    queue.remove('item1');
    open();
    await settled();
    expect(queue.getSnapshot().map((i) => i.id)).toEqual(['item2', 'item3']);
    expect(transport.confirmed).toHaveLength(2);
    expect(queue.mediaIds).toHaveLength(2);
  });
});

describe('createApiUploadTransport', () => {
  it('turns API failures into typed, correctly retryable failures', async () => {
    const transport = createApiUploadTransport({
      presign: () => Promise.resolve({ ok: false, status: 429, code: 'UPLOAD_RATE_LIMITED' }),
      confirm: () => Promise.resolve({ ok: false, status: 422, code: 'UPLOAD_REJECTED' }),
    });
    await expect(
      transport.presign({ byteSize: 1, sha256: 'a', contentType: 'image/webp' }),
    ).rejects.toMatchObject({ code: 'UPLOAD_RATE_LIMITED', retryable: true });
    await expect(transport.confirm('m1')).rejects.toMatchObject({
      code: 'UPLOAD_REJECTED',
      retryable: false,
    });
  });

  it('maps a successful presign to a PUT target', async () => {
    const transport = createApiUploadTransport({
      presign: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: 'm1',
            upload: { url: 'https://s/x', headers: { 'Content-Type': 'image/webp' } },
          },
        }),
      confirm: () => Promise.reject(new Error('socket hang up')),
    });
    await expect(
      transport.presign({ byteSize: 1, sha256: 'a', contentType: 'image/webp' }),
    ).resolves.toEqual({
      mediaId: 'm1',
      url: 'https://s/x',
      headers: { 'Content-Type': 'image/webp' },
    });
    await expect(transport.confirm('m1')).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });
  });
});

describe('compression helpers', () => {
  it('fits the long edge within 1200px without enlarging', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 900, height: 1200 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(12000, 5)).toEqual({ width: 1200, height: 1 });
  });

  it('accepts only the image types the API takes', () => {
    expect(isAcceptedImage(new Blob([], { type: 'image/png' }))).toBe(true);
    expect(isAcceptedImage(new Blob([], { type: 'image/gif' }))).toBe(false);
    expect(isAcceptedImage(new Blob([], { type: 'application/pdf' }))).toBe(false);
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

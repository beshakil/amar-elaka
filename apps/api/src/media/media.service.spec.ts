import sharp from 'sharp';
import type { Queue } from 'bullmq';
import type { ProcessMediaJob } from '../queue/queue.types';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type { SettingsService } from '../settings/settings.service';
import {
  MediaAssetNotFoundException,
  UnsupportedContentTypeException,
  UploadTooLargeException,
} from '../storage/storage.exceptions';
import type { StorageService, StoredObjectInfo } from '../storage/storage.ports';
import {
  UploadMissingException,
  UploadRateLimitedException,
  UploadRejectedException,
} from './media.exceptions';
import { MediaService } from './media.service';
import type { UploadRateLimiter } from './upload-rate-limiter';

const TENANT = '0191e3a0-5151-7000-8000-000000000001';
const USER = '0191e3a0-5151-7000-8000-000000000002';
const SETTINGS: Record<string, number> = {
  media_max_upload_bytes: 10_000_000,
  media_uploads_per_hour: 3,
  media_uploads_per_day: 100,
  media_upload_bytes_per_day: 50_000_000,
};

class MemoryRateLimiter implements UploadRateLimiter {
  counters = new Map<string, number>();
  add(key: string, amount: number): Promise<number> {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
    return Promise.resolve(this.counters.get(key)!);
  }
  refund(key: string, amount: number): Promise<void> {
    this.counters.set(key, (this.counters.get(key) ?? 0) - amount);
    return Promise.resolve();
  }
}

class MemoryStorage implements Partial<StorageService> {
  objects = new Map<string, Buffer>();
  presignUpload = (_b: string, key: string, contentType: string, byteSize: number) =>
    Promise.resolve({
      url: `https://storage.test/${key}`,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType, 'Content-Length': String(byteSize) },
      expiresInSeconds: 300,
    });
  head = (_b: string, key: string): Promise<StoredObjectInfo | undefined> => {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { byteSize: object.length, contentType: undefined } : undefined,
    );
  };
  getObject = (_b: string, key: string, range?: { start: number; end: number }) => {
    const object = this.objects.get(key)!;
    return Promise.resolve(range ? object.subarray(range.start, range.end + 1) : object);
  };
  delete = (_b: string, key: string) => {
    this.objects.delete(key);
    return Promise.resolve();
  };
  getPublicUrl = (_b: string, key: string) => `https://cdn.test/${key}`;
}

/** Just enough of drizzle's builder for the service: one row store. */
function fakeDb(rows: Record<string, unknown>[]): TenantDb {
  const chain = (result: () => unknown[]) => {
    const proxy: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'set', 'values']) {
      proxy[method] = (value?: unknown) => {
        if (method === 'values') {
          rows.push({
            id: `0191e3a0-5151-7000-8000-00000000${String(rows.length + 10).padStart(4, '0')}`,
            statusCode: 'pending_upload',
            width: null,
            height: null,
            thumbhash: null,
            variants: {},
            visibilityCode: 'public',
            ...(value as object),
          });
        }
        return proxy;
      };
    }
    proxy.returning = () => Promise.resolve([rows[rows.length - 1]]);
    proxy.then = (resolve: (v: unknown[]) => void) => resolve(result());
    return proxy;
  };
  const tx = {
    insert: () => chain(() => []),
    select: () => chain(() => rows.slice(0, 1)),
  } as unknown as DatabaseTransaction;
  return {
    transaction: <T>(work: (t: DatabaseTransaction) => Promise<T>) => work(tx),
  } as unknown as TenantDb;
}

function setup(rows: Record<string, unknown>[] = [], overrides: Record<string, number> = {}) {
  const storage = new MemoryStorage();
  const limiter = new MemoryRateLimiter();
  const queued: { name: string; data: unknown; opts: unknown }[] = [];
  const queue = {
    add: (name: string, data: unknown, opts: unknown) => {
      queued.push({ name, data, opts });
      return Promise.resolve();
    },
  } as unknown as Queue<ProcessMediaJob>;
  const settings = {
    get: (key: string) => Promise.resolve(overrides[key] ?? SETTINGS[key]),
  } as unknown as SettingsService;
  const context = new TenantContext();
  jest
    .spyOn(context, 'require')
    .mockReturnValue({ tenantId: TENANT, userId: USER, role: 'member' });
  const service = new MediaService(
    storage as unknown as StorageService,
    limiter,
    queue,
    settings,
    fakeDb(rows),
    context,
  );
  return { service, storage, limiter, queued, rows };
}

const presignInput = (byteSize: number, contentType = 'image/jpeg') => ({
  kind: 'image' as const,
  contentType,
  byteSize,
  checksumSha256: 'a'.repeat(64),
});

describe('MediaService', () => {
  describe('presign', () => {
    it('signs the exact type and size, and records a pending upload', async () => {
      const { service, rows } = setup();
      const result = await service.presign(presignInput(1234));
      expect(result.storageKey.startsWith(`${TENANT}/image/`)).toBe(true);
      expect(result.upload.headers).toEqual({
        'Content-Type': 'image/jpeg',
        'Content-Length': '1234',
      });
      expect(rows[0]).toMatchObject({
        statusCode: 'pending_upload',
        byteSize: 1234,
        uploadedByUserId: USER,
      });
    });

    it('refuses types that are not images and files over the size limit', async () => {
      const { service } = setup();
      await expect(service.presign(presignInput(10, 'image/gif'))).rejects.toThrow(
        UnsupportedContentTypeException,
      );
      await expect(service.presign(presignInput(10, 'text/html'))).rejects.toThrow(
        UnsupportedContentTypeException,
      );
      await expect(service.presign(presignInput(10_000_001))).rejects.toThrow(
        UploadTooLargeException,
      );
    });

    it('enforces the per-user hourly limit and takes refused requests back off the counters', async () => {
      const { service, limiter } = setup();
      for (let i = 0; i < 3; i++) await service.presign(presignInput(100));
      await expect(service.presign(presignInput(100))).rejects.toThrow(UploadRateLimitedException);
      expect(limiter.counters.get(`media:uploads:hour:${USER}`)).toBe(3);
      expect(limiter.counters.get(`media:bytes:day:${USER}`)).toBe(300);
    });

    it('enforces the daily byte budget independently of the upload count', async () => {
      const { service, limiter } = setup([], { media_uploads_per_hour: 100 });
      for (let i = 0; i < 5; i++) await service.presign(presignInput(9_000_000)); // 45 MB
      await expect(service.presign(presignInput(9_000_000))).rejects.toThrow(
        UploadRateLimitedException,
      );
      expect(limiter.counters.get(`media:bytes:day:${USER}`)).toBe(45_000_000);
      // A small file still fits in what's left.
      await expect(service.presign(presignInput(4_000_000))).resolves.toBeDefined();
    });
  });

  describe('confirm', () => {
    async function uploaded(bytes: Buffer, declared = bytes.length) {
      const env = setup();
      const presigned = await env.service.presign(presignInput(declared));
      env.storage.objects.set(presigned.storageKey, bytes);
      return { ...env, presigned };
    }

    it('queues processing once for a real image', async () => {
      const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
        .jpeg()
        .toBuffer();
      const { service, queued, presigned } = await uploaded(jpeg);
      await expect(service.confirm(presigned.id)).resolves.toMatchObject({ status: 'processing' });
      expect(queued).toEqual([
        {
          name: 'process-media',
          data: { tenantId: TENANT, mediaAssetId: presigned.id },
          opts: { jobId: `process-media-${presigned.id}` },
        },
      ]);
    });

    it('rejects and deletes a file whose bytes are not an image', async () => {
      const fake = Buffer.from('<html><script>alert(1)</script></html>');
      const { service, storage, queued, presigned } = await uploaded(fake);
      await expect(service.confirm(presigned.id)).rejects.toThrow(UploadRejectedException);
      expect(storage.objects.has(presigned.storageKey)).toBe(false);
      expect(queued).toEqual([]);
    });

    it('rejects a size different from the one declared', async () => {
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
        .png()
        .toBuffer();
      const { service, storage, presigned } = await uploaded(png, png.length + 1);
      await expect(service.confirm(presigned.id)).rejects.toThrow(UploadRejectedException);
      expect(storage.objects.has(presigned.storageKey)).toBe(false);
    });

    it('asks for the upload first when nothing is stored yet', async () => {
      const { service } = setup();
      const presigned = await service.presign(presignInput(100));
      await expect(service.confirm(presigned.id)).rejects.toThrow(UploadMissingException);
    });

    it("404s for an asset that isn't there", async () => {
      const { service } = setup();
      await expect(service.confirm('0191e3a0-5151-7000-8000-00000000dead')).rejects.toThrow(
        MediaAssetNotFoundException,
      );
    });
  });
});

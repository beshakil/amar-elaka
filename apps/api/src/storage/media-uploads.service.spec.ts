import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type { SettingsService } from '../settings/settings.service';
import { MediaUploadsService } from './media-uploads.service';
import {
  MediaAssetNotFoundException,
  UnsupportedContentTypeException,
  UploadTooLargeException,
} from './storage.exceptions';
import type { PresignedUpload, StorageService } from './storage.ports';

const TENANT_ID = '0191e3a0-0000-7000-8000-00000000001a';
const USER_ID = '0191e3a0-0000-7000-8000-00000000002a';

function fluentReturning(rows: Record<string, unknown>[]) {
  const builder = {
    values: () => builder,
    set: () => builder,
    where: () => builder,
    returning: () => Promise.resolve(rows),
  };
  return builder;
}

class FakeTenantDb {
  constructor(private readonly rows: Record<string, unknown>[] = [{ id: 'row-id' }]) {}
  transaction<T>(work: (tx: unknown) => Promise<T> | T): Promise<T> {
    const tx = {
      insert: () => fluentReturning(this.rows),
      update: () => fluentReturning(this.rows),
    };
    return Promise.resolve(work(tx));
  }
}

function buildService(options?: { rows?: Record<string, unknown>[]; maxBytes?: number }) {
  const presignUpload = jest.fn<Promise<PresignedUpload>, unknown[]>().mockResolvedValue({
    url: 'https://signed.example/upload',
    method: 'PUT',
    headers: {},
    expiresInSeconds: 300,
  });
  const storage: StorageService = {
    presignUpload,
    delete: jest.fn(),
    getPublicUrl: jest.fn(),
  };
  const settingsGet = jest.fn().mockResolvedValue(options?.maxBytes ?? 10_485_760);
  const settings = { get: settingsGet } as unknown as SettingsService;
  const tenantDb = new FakeTenantDb(options?.rows);
  const context = new TenantContext();

  const service = new MediaUploadsService(
    storage,
    settings,
    tenantDb as unknown as TenantDb,
    context,
  );
  return { service, storage, settingsGet, presignUpload, context };
}

describe('MediaUploadsService', () => {
  describe('create', () => {
    it('rejects an unsupported content type before touching settings, storage or the database', async () => {
      const { service, settingsGet, presignUpload, context } = buildService();

      await context.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
        expect(
          service.create({
            kind: 'image',
            contentType: 'application/x-msdownload',
            byteSize: 100,
            checksumSha256: 'a'.repeat(64),
          }),
        ).rejects.toThrow(UnsupportedContentTypeException),
      );

      expect(settingsGet).not.toHaveBeenCalled();
      expect(presignUpload).not.toHaveBeenCalled();
    });

    it('rejects an oversized upload before presigning or writing to the database', async () => {
      const { service, presignUpload, context } = buildService({ maxBytes: 1000 });

      await context.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
        expect(
          service.create({
            kind: 'image',
            contentType: 'image/png',
            byteSize: 2000,
            checksumSha256: 'a'.repeat(64),
          }),
        ).rejects.toThrow(UploadTooLargeException),
      );

      expect(presignUpload).not.toHaveBeenCalled();
    });

    it('presigns into the media bucket for an image and returns the new row id', async () => {
      const { service, presignUpload, context } = buildService({ rows: [{ id: 'asset-1' }] });

      const result = await context.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
        service.create({
          kind: 'image',
          contentType: 'image/png',
          byteSize: 2000,
          checksumSha256: 'a'.repeat(64),
        }),
      );

      expect(result.id).toBe('asset-1');
      expect(presignUpload).toHaveBeenCalledWith(
        'media',
        expect.stringContaining(`${TENANT_ID}/image/`),
        'image/png',
        2000,
      );
    });

    it('presigns into the documents bucket for a document', async () => {
      const { service, presignUpload, context } = buildService();

      await context.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
        service.create({
          kind: 'document',
          contentType: 'application/pdf',
          byteSize: 2000,
          checksumSha256: 'a'.repeat(64),
        }),
      );

      expect(presignUpload).toHaveBeenCalledWith(
        'documents',
        expect.any(String),
        'application/pdf',
        2000,
      );
    });
  });

  describe('confirm', () => {
    it('throws when no row in this tenant matches the id', async () => {
      const { service, context } = buildService({ rows: [] });

      await context.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
        expect(service.confirm('missing-id')).rejects.toThrow(MediaAssetNotFoundException),
      );
    });

    it('flips a matching row to ready', async () => {
      const { service, context } = buildService({ rows: [{ id: 'asset-1' }] });

      const result = await context.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
        service.confirm('asset-1'),
      );

      expect(result).toEqual({ status: 'ready' });
    });
  });
});

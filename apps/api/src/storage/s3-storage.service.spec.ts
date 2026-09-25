const mockSend = jest.fn().mockResolvedValue({});
const mockGetSignedUrl = jest
  .fn<Promise<string>, unknown[]>()
  .mockResolvedValue('https://signed.example/upload');

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import { S3StorageService } from './s3-storage.service';
import { PrivateBucketException, StorageMisconfiguredException } from './storage.exceptions';

const BASE_ENV = {
  STORAGE_DRIVER: 's3' as const,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET_MEDIA: 'media-bucket',
  S3_BUCKET_DOCUMENTS: 'docs-bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_FORCE_PATH_STYLE: true,
  // Contabo's public-sharing link shape: region host, then <account-hash>:<bucket>.
  STORAGE_PUBLIC_URL: 'https://eu2.contabostorage.com/abc123:media-bucket/',
};

describe('S3StorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('presigns a PUT upload with the content type and size signed in', async () => {
    const service = new S3StorageService(BASE_ENV);

    const result = await service.presignUpload('media', 'tenant/image/id', 'image/png', 1024);

    expect(result).toEqual({
      url: 'https://signed.example/upload',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '1024' },
      expiresInSeconds: 300,
    });
  });

  it('builds public media URLs from STORAGE_PUBLIC_URL, whatever the provider', () => {
    const contabo = new S3StorageService(BASE_ENV);
    expect(contabo.getPublicUrl('media', 'tenant/image/id.webp')).toBe(
      'https://eu2.contabostorage.com/abc123:media-bucket/tenant/image/id.webp',
    );
    const b2 = new S3StorageService({
      ...BASE_ENV,
      STORAGE_PUBLIC_URL: 'https://f003.backblazeb2.com/file/media-bucket',
    });
    expect(b2.getPublicUrl('media', 'tenant/image/id.webp')).toBe(
      'https://f003.backblazeb2.com/file/media-bucket/tenant/image/id.webp',
    );
  });

  it('never builds a public URL for the private documents bucket', () => {
    const service = new S3StorageService(BASE_ENV);
    expect(() => service.getPublicUrl('documents', 'tenant/doc/id')).toThrow(
      PrivateBucketException,
    );
  });

  it('deletes an object from the right bucket', async () => {
    const service = new S3StorageService(BASE_ENV);
    await service.delete('documents', 'tenant/doc/id');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error when a required S3 field is missing', () => {
    expect(() => new S3StorageService({ ...BASE_ENV, S3_ENDPOINT: undefined })).toThrow(
      StorageMisconfiguredException,
    );
  });
});

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
import { StorageMisconfiguredException } from './storage.exceptions';

const BASE_ENV = {
  STORAGE_DRIVER: 's3' as const,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET_MEDIA: 'media-bucket',
  S3_BUCKET_DOCUMENTS: 'docs-bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_FORCE_PATH_STYLE: true,
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

  it('builds a path-style public URL', () => {
    const service = new S3StorageService(BASE_ENV);
    expect(service.getPublicUrl('media', 'tenant/image/id')).toBe(
      'http://localhost:9000/media-bucket/tenant/image/id',
    );
  });

  it('builds a virtual-hosted-style URL when path-style is disabled', () => {
    const service = new S3StorageService({ ...BASE_ENV, S3_FORCE_PATH_STYLE: false });
    expect(service.getPublicUrl('documents', 'tenant/doc/id')).toBe(
      'http://docs-bucket.localhost:9000/tenant/doc/id',
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

// settings-exempt: upload-URL validity window for every driver, an infra/security tuning value, not a business rule
export const UPLOAD_URL_TTL_SECONDS = 300;

/** media = public-read (post photos, avatars); documents = private (verification papers). */
export type StorageBucket = 'media' | 'documents';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

/** What a HEAD request reveals about a stored object. */
export interface StoredObjectInfo {
  byteSize: number;
  contentType: string | undefined;
}

export interface StorageService {
  presignUpload(
    bucket: StorageBucket,
    key: string,
    contentType: string,
    byteSize: number,
  ): Promise<PresignedUpload>;
  delete(bucket: StorageBucket, key: string): Promise<void>;
  /** Deletes several objects; missing ones are not an error. */
  deleteMany(bucket: StorageBucket, keys: readonly string[]): Promise<void>;
  /** undefined when the object doesn't exist. */
  head(bucket: StorageBucket, key: string): Promise<StoredObjectInfo | undefined>;
  /** The object's bytes, or only `range` (inclusive byte offsets) of them. */
  getObject(
    bucket: StorageBucket,
    key: string,
    range?: { start: number; end: number },
  ): Promise<Buffer>;
  putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void>;
  getPublicUrl(bucket: StorageBucket, key: string): string;
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

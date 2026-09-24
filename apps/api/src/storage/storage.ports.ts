/** media = public-read (post photos, avatars); documents = private (verification papers). */
export type StorageBucket = 'media' | 'documents';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface StorageService {
  presignUpload(
    bucket: StorageBucket,
    key: string,
    contentType: string,
    byteSize: number,
  ): Promise<PresignedUpload>;
  delete(bucket: StorageBucket, key: string): Promise<void>;
  getPublicUrl(bucket: StorageBucket, key: string): string;
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

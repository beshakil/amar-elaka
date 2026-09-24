import { Inject, Injectable } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { StorageMisconfiguredException } from './storage.exceptions';
import type { PresignedUpload, StorageBucket, StorageService } from './storage.ports';

// settings-exempt: presigned-URL validity window, an infra/security tuning value, not a business rule
const UPLOAD_URL_TTL_SECONDS = 300;

type StorageEnv = Pick<
  Env,
  | 'STORAGE_DRIVER'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET_MEDIA'
  | 'S3_BUCKET_DOCUMENTS'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
>;

function required(value: string | undefined, key: string): string {
  if (!value) throw new StorageMisconfiguredException(key);
  return value;
}

/**
 * Same code path against MinIO (dev) and R2/S3 (prod) — only S3_ENDPOINT and
 * credentials differ. env.schema.ts's superRefine already requires every
 * S3_* field below whenever STORAGE_DRIVER=s3; `required()` is a defensive
 * typed-error boundary, not the primary validation.
 *
 * LocalStorageService (STORAGE_DRIVER=local) is out of scope for this task —
 * nothing in the codebase currently reads STORAGE_LOCAL_PATH/STORAGE_PUBLIC_URL.
 */
@Injectable()
export class S3StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly buckets: Record<StorageBucket, string>;
  private readonly endpoint: string;
  private readonly forcePathStyle: boolean;

  constructor(@Inject(APP_CONFIG) env: StorageEnv) {
    this.endpoint = required(env.S3_ENDPOINT, 'S3_ENDPOINT');
    this.forcePathStyle = env.S3_FORCE_PATH_STYLE;
    this.buckets = {
      media: required(env.S3_BUCKET_MEDIA, 'S3_BUCKET_MEDIA'),
      documents: required(env.S3_BUCKET_DOCUMENTS, 'S3_BUCKET_DOCUMENTS'),
    };
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: required(env.S3_REGION, 'S3_REGION'),
      forcePathStyle: this.forcePathStyle,
      credentials: {
        accessKeyId: required(env.S3_ACCESS_KEY_ID, 'S3_ACCESS_KEY_ID'),
        secretAccessKey: required(env.S3_SECRET_ACCESS_KEY, 'S3_SECRET_ACCESS_KEY'),
      },
    });
  }

  async presignUpload(
    bucket: StorageBucket,
    key: string,
    contentType: string,
    byteSize: number,
  ): Promise<PresignedUpload> {
    // Signing ContentLength/ContentType makes them part of the signature, so
    // the actual PUT must match exactly what was validated at request time —
    // a client can't swap in a larger file or a different type after the URL
    // is issued without invalidating the signature.
    const command = new PutObjectCommand({
      Bucket: this.buckets[bucket],
      Key: key,
      ContentType: contentType,
      ContentLength: byteSize,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(byteSize) },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
  }

  getPublicUrl(bucket: StorageBucket, key: string): string {
    const bucketName = this.buckets[bucket];
    if (this.forcePathStyle) {
      return `${this.endpoint}/${bucketName}/${key}`;
    }
    const endpointUrl = new URL(this.endpoint);
    return `${endpointUrl.protocol}//${bucketName}.${endpointUrl.host}/${key}`;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { StorageMisconfiguredException, StorageUnavailableException } from './storage.exceptions';
import type {
  PresignedUpload,
  StorageBucket,
  StorageService,
  StoredObjectInfo,
} from './storage.ports';

// settings-exempt: presigned-URL validity window, an infra/security tuning value, not a business rule
const UPLOAD_URL_TTL_SECONDS = 300;
// settings-exempt: client retry/timeout tuning for object storage (CLAUDE.md rule 5), not a business rule
const S3_MAX_ATTEMPTS = 3;
// settings-exempt: see above
const S3_CONNECTION_TIMEOUT_MS = 5_000;
// settings-exempt: see above; long enough to move a large original on a slow link
const S3_REQUEST_TIMEOUT_MS = 60_000;
// settings-exempt: S3 DeleteObjects accepts at most 1000 keys per request (protocol limit)
const S3_DELETE_BATCH = 1000;
// settings-exempt: HTTP status code, a protocol constant
const HTTP_NOT_FOUND = 404;

function isNotFound(error: unknown): boolean {
  const meta = error as { $metadata?: { httpStatusCode?: number }; name?: string } | undefined;
  return meta?.$metadata?.httpStatusCode === HTTP_NOT_FOUND || meta?.name === 'NotFound';
}

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
      // Timeouts and retries on every call (the SDK retries with backoff).
      maxAttempts: S3_MAX_ATTEMPTS,
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
      },
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
    await this.call(() =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.buckets[bucket], Key: key })),
    );
  }

  async deleteMany(bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += S3_DELETE_BATCH) {
      const batch = keys.slice(start, start + S3_DELETE_BATCH);
      await this.call(() =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.buckets[bucket],
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        ),
      );
    }
  }

  async head(bucket: StorageBucket, key: string): Promise<StoredObjectInfo | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.buckets[bucket], Key: key }),
      );
      return { byteSize: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new StorageUnavailableException(error);
    }
  }

  async getObject(
    bucket: StorageBucket,
    key: string,
    range?: { start: number; end: number },
  ): Promise<Buffer> {
    return this.call(async () => {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.buckets[bucket],
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!result.Body) return Buffer.alloc(0);
      return Buffer.from(await result.Body.transformToByteArray());
    });
  }

  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    await this.call(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.buckets[bucket],
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          ...(cacheControl ? { CacheControl: cacheControl } : {}),
        }),
      ),
    );
  }

  /** Every storage failure surfaces as one typed error; the SDK has already retried. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new StorageUnavailableException(error);
    }
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

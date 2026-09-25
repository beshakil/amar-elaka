import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import {
  PrivateBucketException,
  StorageMisconfiguredException,
  StorageUnavailableException,
  UploadDoesNotMatchGrantException,
  UploadGrantRejectedException,
} from '../storage.exceptions';
import {
  UPLOAD_URL_TTL_SECONDS,
  type PresignedUpload,
  type StorageBucket,
  type StorageService,
  type StoredObjectInfo,
} from '../storage.ports';
import { signUploadToken, uploadSigningKey, verifyUploadToken } from './upload-token';

// settings-exempt: milliseconds-to-seconds, a unit conversion
const MS_PER_SECOND = 1_000;
const META_SUFFIX = '.meta.json';
// Keys are server-generated (`${tenantId}/${kind}/${uuid}[.variant.webp]`):
// path segments of safe characters, never `..`, never absolute.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
// The route LocalStorageRoutes serves uploads on (outside Nest, see there).
export const LOCAL_UPLOAD_PATH = '/api/v1/storage/uploads';

const metaSchema = z.object({
  contentType: z.string(),
  cacheControl: z.string().optional(),
});
type ObjectMeta = z.infer<typeof metaSchema>;

type LocalStorageEnv = Pick<
  Env,
  'STORAGE_LOCAL_PATH' | 'STORAGE_PUBLIC_URL' | 'API_PUBLIC_URL' | 'JWT_SECRET'
>;

export interface PublicObject {
  stream: ReadStream;
  byteSize: number;
  contentType: string;
  cacheControl: string | undefined;
}

/**
 * StorageService on the local filesystem (ADR 028): dev by default, and the
 * first production setup on a single VPS with a Coolify persistent volume
 * mounted at STORAGE_LOCAL_PATH (shared by the API and the worker).
 *
 * Same contract as S3StorageService, so nothing above this layer knows which
 * driver runs: presigned uploads become HMAC-signed upload URLs served by the
 * API itself, and public media is served from `${API_PUBLIC_URL}/media/…`
 * (STORAGE_PUBLIC_URL). The documents bucket is never served. Keys are the
 * same as on S3, so moving to object storage later is a copy of this
 * directory tree (`<root>/media`, `<root>/documents`) plus an env change.
 */
@Injectable()
export class LocalStorageService implements StorageService {
  private readonly root: string;
  private readonly publicBaseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly signingKey: Buffer;

  constructor(@Inject(APP_CONFIG) env: LocalStorageEnv) {
    this.root = resolve(env.STORAGE_LOCAL_PATH);
    this.publicBaseUrl = env.STORAGE_PUBLIC_URL.replace(/\/+$/, '');
    if (!env.API_PUBLIC_URL) throw new StorageMisconfiguredException('API_PUBLIC_URL');
    this.uploadBaseUrl = `${env.API_PUBLIC_URL.replace(/\/+$/, '')}${LOCAL_UPLOAD_PATH}`;
    this.signingKey = uploadSigningKey(env.JWT_SECRET);
  }

  presignUpload(
    bucket: StorageBucket,
    key: string,
    contentType: string,
    byteSize: number,
  ): Promise<PresignedUpload> {
    this.pathOf(bucket, key); // validates the key before handing out a grant
    const expiresAt = Math.floor(Date.now() / MS_PER_SECOND) + UPLOAD_URL_TTL_SECONDS;
    const token = signUploadToken(this.signingKey, {
      bucket,
      key,
      contentType,
      byteSize,
      expiresAt,
    });
    return Promise.resolve({
      url: `${this.uploadBaseUrl}/${token}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(byteSize) },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
  }

  /**
   * The upload endpoint's work: verify the grant, require the declared type
   * and size to match it exactly (what S3 enforces through the signature),
   * then stream the body to disk — refusing the moment it runs past the size.
   */
  async acceptUpload(
    token: string,
    contentType: string | undefined,
    contentLength: string | undefined,
    body: Readable,
  ): Promise<void> {
    const check = verifyUploadToken(this.signingKey, token, Math.floor(Date.now() / MS_PER_SECOND));
    if (!check.ok) throw new UploadGrantRejectedException(check.reason);
    const { grant } = check;
    if (contentType !== grant.contentType) {
      throw new UploadDoesNotMatchGrantException('content_type');
    }
    if (contentLength !== String(grant.byteSize)) {
      throw new UploadDoesNotMatchGrantException('size');
    }

    const path = this.pathOf(grant.bucket, grant.key);
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > grant.byteSize) done(new UploadDoesNotMatchGrantException('size'));
        else done(null, chunk);
      },
    });
    await this.writeAtomically(path, async (tmp) => {
      await pipeline(body, limit, createWriteStream(tmp));
      if (received !== grant.byteSize) throw new UploadDoesNotMatchGrantException('size');
    });
    await this.writeMeta(path, { contentType: grant.contentType });
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    await this.deleteMany(bucket, [key]);
  }

  async deleteMany(bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    await this.io(async () => {
      for (const key of keys) {
        const path = this.pathOf(bucket, key);
        await rm(path, { force: true });
        await rm(`${path}${META_SUFFIX}`, { force: true });
      }
    });
  }

  async head(bucket: StorageBucket, key: string): Promise<StoredObjectInfo | undefined> {
    const path = this.pathOf(bucket, key);
    const info = await this.io(() => stat(path).catch(notFoundToUndefined));
    if (!info?.isFile()) return undefined;
    const meta = await this.readMeta(path);
    return { byteSize: info.size, contentType: meta?.contentType };
  }

  async getObject(
    bucket: StorageBucket,
    key: string,
    range?: { start: number; end: number },
  ): Promise<Buffer> {
    const path = this.pathOf(bucket, key);
    return this.io(async () => {
      if (!range) return readFile(path);
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(range.end - range.start + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, range.start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    });
  }

  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    const path = this.pathOf(bucket, key);
    await this.writeAtomically(path, (tmp) => writeFile(tmp, body));
    await this.writeMeta(path, cacheControl ? { contentType, cacheControl } : { contentType });
  }

  getPublicUrl(bucket: StorageBucket, key: string): string {
    if (bucket !== 'media') throw new PrivateBucketException(bucket);
    return `${this.publicBaseUrl}/${key}`;
  }

  /** A public media object for the `/media/*` route, or undefined (404). Never documents. */
  async openPublic(key: string): Promise<PublicObject | undefined> {
    if (!SAFE_KEY.test(key) || key.endsWith(META_SUFFIX)) return undefined;
    const path = this.pathOf('media', key);
    const info = await stat(path).catch(notFoundToUndefined);
    if (!info?.isFile()) return undefined;
    const meta = await this.readMeta(path);
    return {
      stream: createReadStream(path),
      byteSize: info.size,
      contentType: meta?.contentType ?? 'application/octet-stream',
      cacheControl: meta?.cacheControl,
    };
  }

  private pathOf(bucket: StorageBucket, key: string): string {
    if (!SAFE_KEY.test(key) || key.endsWith(META_SUFFIX)) {
      throw new UploadGrantRejectedException('unsafe_key');
    }
    const bucketRoot = join(this.root, bucket);
    const path = resolve(bucketRoot, key);
    // Belt and braces: SAFE_KEY already rules out `..` and absolute keys.
    if (!path.startsWith(`${bucketRoot}${sep}`))
      throw new UploadGrantRejectedException('unsafe_key');
    return path;
  }

  /** Write to a temp file beside the target, then rename: readers never see half a file. */
  private async writeAtomically(
    path: string,
    write: (tmp: string) => Promise<void>,
  ): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await write(tmp);
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (error instanceof UploadDoesNotMatchGrantException) throw error;
      throw new StorageUnavailableException(error);
    }
  }

  private async writeMeta(path: string, meta: ObjectMeta): Promise<void> {
    await this.writeAtomically(`${path}${META_SUFFIX}`, (tmp) =>
      writeFile(tmp, JSON.stringify(meta)),
    );
  }

  private async readMeta(path: string): Promise<ObjectMeta | undefined> {
    const raw = await readFile(`${path}${META_SUFFIX}`, 'utf8').catch(notFoundToUndefined);
    if (raw === undefined) return undefined;
    const parsed = metaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }

  private async io<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new StorageUnavailableException(error);
    }
  }
}

function notFoundToUndefined(error: unknown): undefined {
  if ((error as { code?: string }).code === 'ENOENT') return undefined;
  throw error;
}

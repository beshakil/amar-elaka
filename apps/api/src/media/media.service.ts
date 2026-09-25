import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { mediaAssets } from '../database/schema/content';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { JOB_PROCESS_MEDIA, QUEUE_MEDIA, type ProcessMediaJob } from '../queue/queue.types';
import { SettingsService } from '../settings/settings.service';
import { MEDIA_KIND_POLICIES } from '../storage/media-kind.constants';
import {
  MediaAssetNotFoundException,
  UnsupportedContentTypeException,
  UploadTooLargeException,
} from '../storage/storage.exceptions';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type { MediaStatus, PresignMediaInput, PresignedMedia } from './dto/media.dto';
import { IMAGE_SIGNATURE_BYTES, sniffMediaType } from './image-signature';
import {
  UploadMissingException,
  UploadRateLimitedException,
  UploadRejectedException,
} from './media.exceptions';
import { parseVariants, variantKeys } from './media.types';
import { UPLOAD_RATE_LIMITER, type UploadRateLimiter } from './upload-rate-limiter';

// settings-exempt: unit conversions for the rate-limit windows, not thresholds
const HOUR_SECONDS = 60 * 60;
// settings-exempt: see above
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * The API half of the media pipeline. File bytes never pass through the API
 * (the client PUTs straight to object storage with a presigned URL); the API
 * only reads the first few bytes back to check what was really uploaded.
 *
 *   presign  -> rate limits, type and size checks, a URL with the exact size
 *               and type signed in, a `pending_upload` row
 *   confirm  -> the object exists, has the declared size and a real image (or
 *               PDF/video) signature; then the worker takes over
 *               (media-processing.service.ts): EXIF strip, variants, ThumbHash
 *   get      -> status and variant URLs, for the client to poll
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(UPLOAD_RATE_LIMITER) private readonly rateLimiter: UploadRateLimiter,
    @InjectQueue(QUEUE_MEDIA) private readonly queue: Queue<ProcessMediaJob>,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
  ) {}

  async presign(input: PresignMediaInput): Promise<PresignedMedia> {
    const { tenantId, userId } = this.requireUser();

    const policy = MEDIA_KIND_POLICIES[input.kind];
    if (!policy.allowedContentTypes.includes(input.contentType)) {
      throw new UnsupportedContentTypeException();
    }
    if (input.byteSize > (await this.settings.get('media_max_upload_bytes', tenantId))) {
      throw new UploadTooLargeException();
    }
    await this.enforceRateLimits(userId, input.byteSize, tenantId);

    const storageKey = `${tenantId}/${input.kind}/${randomUUID()}`;
    const upload = await this.storage.presignUpload(
      policy.bucket,
      storageKey,
      input.contentType,
      input.byteSize,
    );
    const [row] = await this.tenantDb.transaction((tx) =>
      tx
        .insert(mediaAssets)
        .values({
          tenantId,
          uploadedByUserId: userId,
          kindCode: input.kind,
          visibilityCode: policy.visibilityCode,
          storageKey,
          // Declared for now; the worker replaces it with the sniffed type.
          mimeType: input.contentType,
          byteSize: input.byteSize,
          checksumSha256: input.checksumSha256.toLowerCase(),
        })
        .returning({ id: mediaAssets.id }),
    );
    return { id: row!.id, storageKey, upload };
  }

  async confirm(id: string): Promise<MediaStatus> {
    const { tenantId, userId } = this.requireUser();
    const row = await this.ownRow(id, tenantId, userId);

    // Already confirmed: confirming again is harmless.
    if (row.statusCode !== 'pending_upload') return this.toStatus(row);

    const bucket = MEDIA_KIND_POLICIES[row.kindCode].bucket;
    const stored = await this.storage.head(bucket, row.storageKey);
    if (!stored) throw new UploadMissingException();

    if (stored.byteSize !== row.byteSize) {
      await this.storage.delete(bucket, row.storageKey);
      throw new UploadRejectedException('size_mismatch');
    }
    const head = await this.storage.getObject(bucket, row.storageKey, {
      start: 0,
      end: IMAGE_SIGNATURE_BYTES - 1,
    });
    if (sniffMediaType(row.kindCode, head) === undefined) {
      // Not what it claims to be: remove it now. The row goes with the
      // orphan sweep (a member can't delete rows).
      await this.storage.delete(bucket, row.storageKey);
      throw new UploadRejectedException(row.kindCode === 'image' ? 'not_an_image' : 'wrong_type');
    }

    await this.queue.add(
      JOB_PROCESS_MEDIA,
      { tenantId, mediaAssetId: id },
      // One job per asset, however many times confirm is called. BullMQ
      // rejects ':' in custom ids ("Custom Id cannot contain :"), so '-'.
      { jobId: `${JOB_PROCESS_MEDIA}-${id}` },
    );
    return { ...this.toStatus(row), status: 'processing' };
  }

  async get(id: string): Promise<MediaStatus> {
    const { tenantId, userId } = this.requireUser();
    return this.toStatus(await this.ownRow(id, tenantId, userId));
  }

  /**
   * Counts first, then compares: two uploads racing each other can't both
   * slip under a limit. A refused upload is taken back off every counter.
   */
  private async enforceRateLimits(userId: string, bytes: number, tenantId: string): Promise<void> {
    const [perHour, perDay, bytesPerDay] = await Promise.all([
      this.settings.get('media_uploads_per_hour', tenantId),
      this.settings.get('media_uploads_per_day', tenantId),
      this.settings.get('media_upload_bytes_per_day', tenantId),
    ]);
    const counters = [
      { key: `media:uploads:hour:${userId}`, amount: 1, window: HOUR_SECONDS, limit: perHour },
      { key: `media:uploads:day:${userId}`, amount: 1, window: DAY_SECONDS, limit: perDay },
      { key: `media:bytes:day:${userId}`, amount: bytes, window: DAY_SECONDS, limit: bytesPerDay },
    ];
    const totals = await Promise.all(
      counters.map((c) => this.rateLimiter.add(c.key, c.amount, c.window)),
    );
    if (totals.some((total, index) => total > counters[index]!.limit)) {
      await Promise.all(counters.map((c) => this.rateLimiter.refund(c.key, c.amount)));
      throw new UploadRateLimitedException();
    }
  }

  private requireUser(): { tenantId: string; userId: string } {
    const { tenantId, userId } = this.tenantContext.require();
    if (!tenantId || !userId) throw new TenantRequiredException();
    return { tenantId, userId };
  }

  private async ownRow(id: string, tenantId: string, userId: string) {
    const [row] = await this.tenantDb.transaction(
      (tx) =>
        tx
          .select({
            id: mediaAssets.id,
            kindCode: mediaAssets.kindCode,
            visibilityCode: mediaAssets.visibilityCode,
            storageKey: mediaAssets.storageKey,
            mimeType: mediaAssets.mimeType,
            byteSize: mediaAssets.byteSize,
            width: mediaAssets.width,
            height: mediaAssets.height,
            statusCode: mediaAssets.statusCode,
            thumbhash: mediaAssets.thumbhash,
            variants: mediaAssets.variants,
          })
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.id, id),
              eq(mediaAssets.tenantId, tenantId),
              eq(mediaAssets.uploadedByUserId, userId),
            ),
          )
          .limit(1),
      { accessMode: 'read only' },
    );
    if (!row) throw new MediaAssetNotFoundException();
    return {
      ...row,
      kindCode: row.kindCode as 'image' | 'video' | 'document',
      byteSize: Number(row.byteSize),
    };
  }

  private toStatus(row: Awaited<ReturnType<MediaService['ownRow']>>): MediaStatus {
    const variants = parseVariants(row.variants);
    const bucket = MEDIA_KIND_POLICIES[row.kindCode].bucket;
    const publicVariants =
      row.statusCode === 'ready' && row.visibilityCode === 'public' && variants
        ? Object.fromEntries(
            variantKeys.map((name) => [
              name,
              {
                url: this.storage.getPublicUrl(bucket, variants[name].key),
                width: variants[name].width,
                height: variants[name].height,
              },
            ]),
          )
        : null;
    return {
      id: row.id,
      status: row.statusCode as MediaStatus['status'],
      kind: row.kindCode,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      width: row.width,
      height: row.height,
      thumbhash: row.thumbhash,
      variants: publicVariants as MediaStatus['variants'],
    };
  }
}

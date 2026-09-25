import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { mediaAssets } from '../database/schema/content';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { MEDIA_KIND_POLICIES } from '../storage/media-kind.constants';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { sniffMediaType, type SniffedImageType } from './image-signature';
import { InvalidImageError, processImage, type ProcessedImage } from './image-pipeline';
import { variantKey, variantKeys, type StoredVariants } from './media.types';

// settings-exempt: variant keys are unique and never rewritten, so browsers and CDNs may cache them forever
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export type ProcessOutcome = 'ready' | 'rejected' | 'skipped';

/** The file itself is unusable; retrying can't help (the processor won't). */
export class UnprocessableMediaError extends Error {}

type Kind = 'image' | 'video' | 'document';

interface AssetRow {
  id: string;
  kindCode: Kind;
  visibilityCode: string;
  storageKey: string;
  statusCode: string;
  byteSize: number;
}

/**
 * The worker half of the media pipeline (runs as `system`, so it may move
 * `status_code`, which members can't: media_assets_protect_status, 0005).
 *
 * For an image:
 *   1. download the original and check its magic bytes again (the first check
 *      only read a few bytes; this is the whole file);
 *   2. decode it with sharp under a pixel limit (decompression bombs);
 *   3. rotate by EXIF orientation, then write it back with **no metadata at
 *      all** (GPS, camera serials, timestamps), in its own format;
 *   4. write thumb / card / full WebP variants (long edge from settings,
 *      never enlarged) with immutable caching;
 *   5. compute a ThumbHash placeholder;
 *   6. record real type, size, dimensions, variants, placeholder: `ready`.
 * Anything that isn't really an image is `rejected` and its objects deleted.
 * PDFs and videos only get the signature check.
 */
@Injectable()
export class MediaProcessingService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MediaProcessingService.name);
  }

  process(tenantId: string, mediaAssetId: string): Promise<ProcessOutcome> {
    return this.tenantContext.run({ tenantId, role: 'system' }, () =>
      this.processAsSystem(tenantId, mediaAssetId),
    );
  }

  private async processAsSystem(tenantId: string, id: string): Promise<ProcessOutcome> {
    const row = await this.claim(tenantId, id);
    if (!row) return 'skipped';

    const bucket = MEDIA_KIND_POLICIES[row.kindCode].bucket;
    const written: string[] = [];
    try {
      const original = await this.storage.getObject(bucket, row.storageKey);
      const sniffed = sniffMediaType(row.kindCode, original);
      if (!sniffed) throw new UnprocessableMediaError('signature does not match the media kind');

      if (row.kindCode !== 'image') {
        await this.finish(id, { mimeType: sniffed, byteSize: original.length });
        return 'ready';
      }

      const [maxInputPixels, quality, thumb, card, full] = await Promise.all([
        this.settings.get('media_max_input_pixels', tenantId),
        this.settings.get('media_image_quality', tenantId),
        this.settings.get('media_variant_thumb_px', tenantId),
        this.settings.get('media_variant_card_px', tenantId),
        this.settings.get('media_variant_full_px', tenantId),
      ]);
      let image: ProcessedImage;
      try {
        image = await processImage(original, sniffed as SniffedImageType, {
          maxInputPixels,
          quality,
          variantSizes: { thumb, card, full },
        });
      } catch (error) {
        if (error instanceof InvalidImageError) throw new UnprocessableMediaError(error.message);
        throw error;
      }

      // The metadata-free original replaces what the client uploaded.
      await this.storage.putObject(bucket, row.storageKey, image.original.data, sniffed);
      const variants = {} as StoredVariants;
      for (const name of variantKeys) {
        const variant = image.variants[name];
        const key = variantKey(row.storageKey, name);
        await this.storage.putObject(bucket, key, variant.data, 'image/webp', IMMUTABLE_CACHE);
        written.push(key);
        variants[name] = {
          key,
          width: variant.width,
          height: variant.height,
          bytes: variant.data.length,
        };
      }
      await this.finish(id, {
        mimeType: sniffed,
        byteSize: image.original.data.length,
        width: image.original.width,
        height: image.original.height,
        variants,
        thumbhash: image.thumbhash,
      });
      return 'ready';
    } catch (error) {
      if (!(error instanceof UnprocessableMediaError)) throw error; // transient: retry
      this.logger.warn({ mediaAssetId: id, reason: error.message }, 'media rejected');
      await this.storage.deleteMany(bucket, [row.storageKey, ...written]);
      await this.setStatus(id, 'rejected');
      return 'rejected';
    }
  }

  /** Moves a pending (or retried) asset to `processing`; undefined if there's nothing to do. */
  private async claim(tenantId: string, id: string): Promise<AssetRow | undefined> {
    return this.tenantDb.transaction(async (tx) => {
      const [row] = await tx
        .update(mediaAssets)
        .set({ statusCode: 'processing' })
        .where(
          and(
            eq(mediaAssets.id, id),
            eq(mediaAssets.tenantId, tenantId),
            inArray(mediaAssets.statusCode, ['pending_upload', 'processing']),
          ),
        )
        .returning({
          id: mediaAssets.id,
          kindCode: mediaAssets.kindCode,
          visibilityCode: mediaAssets.visibilityCode,
          storageKey: mediaAssets.storageKey,
          statusCode: mediaAssets.statusCode,
          byteSize: mediaAssets.byteSize,
        });
      return row
        ? { ...row, kindCode: row.kindCode as Kind, byteSize: Number(row.byteSize) }
        : undefined;
    });
  }

  private async finish(
    id: string,
    result: {
      mimeType: string;
      byteSize: number;
      width?: number;
      height?: number;
      variants?: StoredVariants;
      thumbhash?: string;
    },
  ): Promise<void> {
    await this.tenantDb.transaction((tx) =>
      tx
        .update(mediaAssets)
        .set({
          statusCode: 'ready',
          mimeType: result.mimeType,
          byteSize: result.byteSize,
          ...(result.width !== undefined ? { width: result.width } : {}),
          ...(result.height !== undefined ? { height: result.height } : {}),
          ...(result.variants ? { variants: result.variants } : {}),
          ...(result.thumbhash ? { thumbhash: result.thumbhash } : {}),
        })
        .where(eq(mediaAssets.id, id)),
    );
  }

  private async setStatus(id: string, status: 'rejected'): Promise<void> {
    await this.tenantDb.transaction((tx) =>
      tx.update(mediaAssets).set({ statusCode: status }).where(eq(mediaAssets.id, id)),
    );
  }
}

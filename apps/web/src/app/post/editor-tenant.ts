import { DEFAULT_MAX_ITEMS } from '@/lib/media/upload-queue';
import { UPLOAD_COMPRESSION } from '@/lib/media/compress-image';
import type { EditorTenant } from './post-editor';

/** What the editor needs to know about the area. */
export function editorTenant(tenant: {
  id: string;
  nameBn: string;
  mapCenter: { lat: number; lng: number };
  moderation?: { typicalReviewHours: number } | undefined;
  media?:
    | { postMaxPhotos: number; imageMaxLongEdgePx: number; imageQuality?: number | undefined }
    | undefined;
}): EditorTenant {
  return {
    id: tenant.id,
    nameBn: tenant.nameBn,
    mapCenter: tenant.mapCenter,
    // The seeded default (moderation_typical_review_hours) for an older API.
    typicalReviewHours: tenant.moderation?.typicalReviewHours ?? 12,
    // The seeded defaults (post_max_media, media_variant_full_px) for an older API.
    maxPhotos: tenant.media?.postMaxPhotos ?? DEFAULT_MAX_ITEMS,
    imageMaxLongEdgePx: tenant.media?.imageMaxLongEdgePx ?? UPLOAD_COMPRESSION.maxLongEdge,
    // media_image_quality is 0-100; the canvas encoder takes 0-1.
    imageQuality:
      tenant.media?.imageQuality === undefined
        ? UPLOAD_COMPRESSION.quality
        : tenant.media.imageQuality / 100,
  };
}

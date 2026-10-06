import { z } from 'zod';
import { createZodDto } from '../common/pipes/zod-dto';
import { MAP_LAYERS } from '../settings/settings.registry';

/**
 * GET /map/features/:layer/:id?tenant= (ADR 046): what the Map tab's preview
 * sheet shows beyond the feature itself — a photo, phone numbers and an
 * address — read in the owning tenant's context (its public-read policies),
 * one small request per tap instead of 500 heavier features.
 */
export const mapPreviewParamsSchema = z.object({
  layer: z.enum(MAP_LAYERS),
  id: z.string().uuid(),
});
export class MapPreviewParamsDto extends createZodDto(mapPreviewParamsSchema) {}
export type MapPreviewParams = z.infer<typeof mapPreviewParamsSchema>;

export const mapPreviewQuerySchema = z.object({
  /** The feature's `tenant_id` (every map point carries it). */
  tenant: z.string().uuid(),
});
export class MapPreviewQueryDto extends createZodDto(mapPreviewQuerySchema) {}
export type MapPreviewQuery = z.infer<typeof mapPreviewQuerySchema>;

export const mapPreviewResponseSchema = z.object({
  layer: z.enum(MAP_LAYERS),
  id: z.string(),
  tenantId: z.string(),
  name: z.object({ bn: z.string().nullable(), en: z.string().nullable() }),
  /** The cover (card-size WebP) and its thumbhash; null when there is none. */
  photo: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
  /**
   * Public numbers (E.164 or local short codes) for stores, places and
   * emergency services. Always empty for a post: its call button goes through
   * the post's contact action (lead tracking), never a number here.
   */
  phones: z.array(z.string()),
  /** The street address as entered, or the post's area name. */
  address: z.string().nullable(),
});
export type MapPreview = z.infer<typeof mapPreviewResponseSchema>;
export class MapPreviewResponseDto extends createZodDto(mapPreviewResponseSchema) {}

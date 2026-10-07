import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { MAP_LAYERS } from '../../settings/settings.registry';

const file = z.object({
  /** Path under the tiles root (keep it as the local relative path). */
  path: z.string(),
  url: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

/**
 * GET /map/offline (ADR 050): everything the app needs to keep this area's
 * map on the phone — the tenant's archive, the fonts and sprites its style
 * reads, the points to cache and how often to look for a new version.
 */
export const offlineMapManifestSchema = z.object({
  available: z.boolean(),
  /** Why there's no file: not built yet, too big at every zoom, or the last build failed. */
  reason: z.enum(['not_built', 'too_large', 'failed']).nullable(),
  archive: file
    .extend({
      /** The national version it was cut from: a different one = an update. */
      version: z.string(),
      maxZoom: z.number(),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      builtAt: z.string(),
    })
    .nullable(),
  /** Glyph ranges (offline_map_glyph_ranges), Bengali font files and sprites. */
  assets: z.array(file),
  assetsBytes: z.number(),
  /** Archive + assets: show it before downloading. */
  totalBytes: z.number(),
  /** The /map/features queries whose points to keep offline (offline_map_point_sets). */
  pointSets: z.array(
    z.object({
      layers: z.array(z.enum(MAP_LAYERS)),
      kinds: z.array(z.string()).nullable(),
    }),
  ),
  /** map_label_language, for drawing the offline style without GET /map/config. */
  labelLanguage: z.string(),
  updateCheckHours: z.number(),
});
export type OfflineMapManifest = z.infer<typeof offlineMapManifestSchema>;
export class OfflineMapManifestDto extends createZodDto(offlineMapManifestSchema) {}

/** GET /map/offline/areas: the tenant's area and the areas inside it, simplified, as GeoJSON. */
export const offlineAreasSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
});
export type OfflineAreas = z.infer<typeof offlineAreasSchema>;
export class OfflineAreasDto extends createZodDto(offlineAreasSchema) {}

import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const storeActivityQuerySchema = z
  .object({ months: z.coerce.number().int().positive().optional() })
  .strict();
export type StoreActivityQuery = z.infer<typeof storeActivityQuerySchema>;
export class StoreActivityQueryDto extends createZodDto(storeActivityQuerySchema) {}

export const storeActivitySchema = z.object({
  months: z.array(
    z.object({
      /** First day of the Dhaka calendar month, YYYY-MM-DD. Newest first. */
      month: z.string(),
      /** Stores active now that existed by the month's end (no status history is kept). */
      activeStores: z.number(),
      /** Of those, stores that published at least one post in the month. */
      postingStores: z.number(),
      storePosts: z.number(),
      /** The deciding metric for a following feed (ADR 037); null with no active store. */
      avgPostsPerActiveStore: z.string().nullable(),
      avgPostsPerPostingStore: z.string().nullable(),
    }),
  ),
});
export type StoreActivity = z.infer<typeof storeActivitySchema>;
export class StoreActivityDto extends createZodDto(storeActivitySchema) {}

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });

/** GET /analytics/unmet-demand (ADR 041): the tenant's demand nothing answers yet. */
export const unmetDemandSchema = z.object({
  /** When the view was last refreshed; null before the first refresh saw any demand. */
  refreshedAt: z.string().nullable(),
  /** unmet_demand_result_threshold and unmet_demand_window_days at the time of the request. */
  resultThreshold: z.number().int(),
  windowDays: z.number().int(),
  rows: z.array(
    z.object({
      /** Null: searches with no category. */
      category: z
        .object({ id: z.string(), slug: z.string().nullable(), name: localized })
        .nullable(),
      /** The finest area holding the search; null when the searcher shared no location. */
      geoArea: z.object({ id: z.string(), name: localized }).nullable(),
      /** Active saved searches here: people waiting to be told when something appears. */
      activeSavedSearches: z.number().int(),
      /** Searches in the window that found fewer than the threshold. */
      weakSearches: z.number().int(),
    }),
  ),
});
export type UnmetDemand = z.infer<typeof unmetDemandSchema>;
export class UnmetDemandDto extends createZodDto(unmetDemandSchema) {}

// ---- demand/supply heatmap (ADR 050) -------------------------------------------

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const heatmapQuerySchema = z
  .object({
    /** demand: searches and saved searches; supply: live posts and stores. */
    type: z.enum(['demand', 'supply']),
    /** A category slug, with its subcategories (stores have none: left out). */
    category: slug.optional(),
  })
  .strict();
export type HeatmapQuery = z.infer<typeof heatmapQuerySchema>;
export class HeatmapQueryDto extends createZodDto(heatmapQuerySchema) {}

export const heatmapSchema = z.object({
  type: z.enum(['demand', 'supply']),
  category: z.string().nullable(),
  /** Geohash length of the grid (heatmap_geohash_precision). */
  precision: z.number(),
  /** No cell has fewer distinct people than this (heatmap_min_cell_count). */
  minCellCount: z.number(),
  /** Demand: how far back searches count (heatmap_window_days). */
  windowDays: z.number(),
  /**
   * Cells, densest first: the geohash, its centre (never a real point), and
   * how many searches / listings fall in it.
   */
  cells: z.array(
    z.object({ geohash: z.string(), lat: z.number(), lng: z.number(), count: z.number() }),
  ),
});
export type Heatmap = z.infer<typeof heatmapSchema>;
export class HeatmapDto extends createZodDto(heatmapSchema) {}

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

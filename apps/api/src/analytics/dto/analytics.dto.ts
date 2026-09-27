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

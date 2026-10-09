import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { POST_STATUSES } from '../../posts/post-state-machine';
import { STOCK_STATUSES } from '../../posts/post-stock';

export const storeProductsQuerySchema = z
  .object({
    /** Comma-separated statuses, e.g. `live,pending`; absent = every status. */
    status: z
      .string()
      .transform((raw) =>
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      )
      .pipe(z.array(z.enum(POST_STATUSES)).min(1))
      .optional(),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type StoreProductsQuery = z.infer<typeof storeProductsQuerySchema>;
export class StoreProductsQueryDto extends createZodDto(storeProductsQuerySchema) {}

export const storeProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  categoryId: z.string(),
  /** Money as a string with two decimals; null = price on request. */
  price: z.string().nullable(),
  priceType: z.string().nullable(),
  status: z.enum(POST_STATUSES),
  stockStatus: z.enum(STOCK_STATUSES),
  hidden: z.boolean(),
  thumbUrl: z.string().nullable(),
  views: z.number(),
  saves: z.number(),
  expiresAt: z.string().nullable(),
  updatedAt: z.string(),
  /** The caller wrote it. */
  isMine: z.boolean(),
  /** The caller may change it: its author, or the store's owner or a manager (ADR 057). */
  canManage: z.boolean(),
});
export type StoreProduct = z.infer<typeof storeProductSchema>;

export const storeProductsSchema = z.object({
  items: z.array(storeProductSchema),
  nextCursor: z.string().nullable(),
});
export type StoreProducts = z.infer<typeof storeProductsSchema>;
export class StoreProductsDto extends createZodDto(storeProductsSchema) {}

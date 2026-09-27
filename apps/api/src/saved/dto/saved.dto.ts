import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const SAVED_ITEM_TYPES = ['post', 'place', 'store'] as const;
export type SavedItemType = (typeof SAVED_ITEM_TYPES)[number];

/**
 * What became of a saved item (my_saved_items, 0032). A saved item never
 * drops out of the list; this says why it may no longer be open to act on.
 */
export const SAVED_ITEM_STATES = [
  'available',
  'sold',
  'expired',
  'unavailable',
  'deleted',
  'removed',
  'temporarily_closed',
  'closed',
] as const;

// ---- requests --------------------------------------------------------------

export const savedItemParamSchema = z
  .object({ itemType: z.enum(SAVED_ITEM_TYPES), itemId: z.string().uuid() })
  .strict();
export type SavedItemParam = z.infer<typeof savedItemParamSchema>;
export class SavedItemParamDto extends createZodDto(savedItemParamSchema) {}

export const savedQuerySchema = z
  .object({
    type: z.enum(SAVED_ITEM_TYPES).optional(),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type SavedQuery = z.infer<typeof savedQuerySchema>;
export class SavedQueryDto extends createZodDto(savedQuerySchema) {}

export const storeIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class StoreIdParamDto extends createZodDto(storeIdParamSchema) {}

// ---- responses -------------------------------------------------------------

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });

export const savedItemSchema = z.object({
  itemType: z.enum(SAVED_ITEM_TYPES),
  itemId: z.string(),
  tenantId: z.string(),
  savedAt: z.string(),
  state: z.enum(SAVED_ITEM_STATES),
  /** Null for a post a moderator removed: nothing of it is shown. */
  name: localized.nullable(),
  /** A place's or store's page slug, while it can be opened. */
  slug: z.string().nullable(),
  /** Posts only, while available, sold or expired. */
  price: z.string().nullable(),
  priceType: z.string().nullable(),
  cover: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
  area: localized.nullable(),
});
export type SavedItem = z.infer<typeof savedItemSchema>;

export const savedPageSchema = z.object({
  items: z.array(savedItemSchema),
  nextCursor: z.string().nullable(),
});
export type SavedPage = z.infer<typeof savedPageSchema>;
export class SavedPageDto extends createZodDto(savedPageSchema) {}

export const saveResultSchema = z.object({
  itemType: z.enum(SAVED_ITEM_TYPES),
  itemId: z.string(),
  savedAt: z.string(),
  /** False when it was already saved (the call is idempotent). */
  created: z.boolean(),
});
export type SaveResult = z.infer<typeof saveResultSchema>;
export class SaveResultDto extends createZodDto(saveResultSchema) {}

export const followResultSchema = z.object({
  storeId: z.string(),
  following: z.boolean(),
  /** Null when the store is no longer public (an unfollow of a closed store). */
  followerCount: z.number().nullable(),
});
export type FollowResult = z.infer<typeof followResultSchema>;
export class FollowResultDto extends createZodDto(followResultSchema) {}

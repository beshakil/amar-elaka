import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { STOCK_STATUSES } from '../../posts/post-stock';

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });

/**
 * GET /stores/:slug/catalog (ADR 056): the WhatsApp catalog's data — small
 * on purpose (one card-size photo per product). No phone number anywhere:
 * an order is POST /stores/:slug/catalog/order/:postId.
 */
export const storeCatalogSchema = z.object({
  store: z.object({
    id: z.string(),
    tenantId: z.string(),
    slug: z.string(),
    name: localized,
    description: z.string().nullable(),
    logo: z.object({ url: z.string() }).nullable(),
    cover: z.object({ url: z.string() }).nullable(),
    /** The store has a WhatsApp (or phone) number to order on. */
    orderable: z.boolean(),
  }),
  products: z.array(
    z.object({
      postId: z.string(),
      title: z.string(),
      price: z.string().nullable(),
      priceType: z.string().nullable(),
      /** Out of stock shows no order button (ADR 057). */
      stockStatus: z.enum(STOCK_STATUSES),
      photo: z
        .object({
          url: z.string(),
          width: z.number(),
          height: z.number(),
          thumbhash: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  /** The link preview's image, under the API base. */
  shareImagePath: z.string(),
});
export type StoreCatalog = z.infer<typeof storeCatalogSchema>;
export class StoreCatalogDto extends createZodDto(storeCatalogSchema) {}

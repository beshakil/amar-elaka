import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseVariants } from '../../media/media.types';
import { POST_STATUSES } from '../../posts/post-state-machine';
import { stockStatusOf } from '../../posts/post-stock';
import { SettingsService } from '../../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/storage.ports';
import { StoreScope } from '../store-scope';
import type { StoreProducts, StoreProductsQuery } from './store-products.dto';

const PRODUCT_ROW = z.object({
  id: z.string(),
  title: z.string(),
  category_id: z.string(),
  price: z.string().nullable(),
  price_type_code: z.string().nullable(),
  status_code: z.enum(POST_STATUSES),
  store_id: z.string(),
  stock_status_code: z.string().nullable(),
  hidden_by_owner: z.boolean(),
  view_count: z.number(),
  saved_count: z.number(),
  expires_at: z.coerce.date().nullable(),
  updated_at: z.coerce.date(),
  mine: z.boolean(),
  manages: z.boolean(),
  variants: z.unknown(),
});

/**
 * The seller panel's product table (ADR 057): every post of the store the
 * caller may see — all of them for its owner and managers
 * (posts_store_manager_read), their own plus the public ones for an editor —
 * newest first. Changing one goes through the ordinary post endpoints.
 */
@Injectable()
export class StoreProductsService {
  constructor(
    private readonly scope: StoreScope,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async list(storeId: string, query: StoreProductsQuery): Promise<StoreProducts> {
    const { tenantId } = await this.scope.asPoster(storeId);
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('post_list_page_size_default'),
      this.settings.get('post_list_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const rows = await this.scope.read(tenantId, async (tx) => {
      const found = await tx.execute(sql`
        select p.id, p.title, p.category_id, p.price::text as price, p.price_type_code, p.status_code,
               p.store_id, p.stock_status_code, p.hidden_by_owner, p.view_count, p.saved_count,
               p.expires_at, p.updated_at,
               coalesce(p.author_member_id = public.current_member_id(), false) as mine,
               public.can_manage_store(p.store_id) as manages, cover.variants
        from public.posts p
        left join lateral (
          select m.variants
          from public.media_attachments a
          join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
          where a.tenant_id = p.tenant_id and a.post_id = p.id
            and m.status_code = 'ready' and m.visibility_code = 'public'
          order by a.sort_order limit 1
        ) cover on true
        where p.tenant_id = public.current_tenant_id() and p.store_id = ${storeId}::uuid
          and p.deleted_at is null and p.scrubbed_at is null
          ${query.status ? sql`and p.status_code = any (${`{${query.status.join(',')}}`}::text[])` : sql``}
          ${query.cursor ? sql`and p.id < ${query.cursor}::uuid` : sql``}
        order by p.id desc
        limit ${limit + 1}`);
      return z.array(PRODUCT_ROW).parse([...found]);
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const variants = parseVariants(row.variants);
        return {
          id: row.id,
          title: row.title,
          categoryId: row.category_id,
          price: row.price,
          priceType: row.price_type_code,
          status: row.status_code,
          stockStatus: stockStatusOf(row.store_id, row.stock_status_code) ?? 'in_stock',
          hidden: row.hidden_by_owner,
          thumbUrl: variants ? this.storage.getPublicUrl('media', variants.thumb.key) : null,
          views: row.view_count,
          saves: row.saved_count,
          expiresAt: row.expires_at?.toISOString() ?? null,
          updatedAt: row.updated_at.toISOString(),
          isMine: row.mine,
          canManage: row.mine || row.manages,
        };
      }),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}

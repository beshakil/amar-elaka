import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { toCsv } from '../../common/files/csv';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { TenantRequiredException } from '../../database/tenant.exceptions';
import { ShareService } from '../../engagement/share.service';
import { parseVariants } from '../../media/media.types';
import { stockStatusOf, type StockStatus } from '../../posts/post-stock';
import { storeCardPng } from '../../seo/og-image/og-image.service';
import { PostOwnershipService } from '../../posts/post-ownership.service';
import { SettingsService } from '../../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/storage.ports';
import { storeCan } from '../store-access';
import { StoreActionForbiddenException, StoreNotFoundException } from '../stores.exceptions';
import { StoresRepository } from '../stores.repository';
import type { StoreCatalog } from './store-catalog.dto';

const PRODUCT_ROW = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  price: z.string().nullable(),
  price_type_code: z.string().nullable(),
  condition: z.string().nullable(),
  store_id: z.string(),
  stock_status_code: z.string().nullable(),
  variants: z.unknown(),
  thumbhash: z.string().nullable(),
});
type ProductRow = z.infer<typeof PRODUCT_ROW>;

const STORE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  tenant_slug: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  description: z.string().nullable(),
  logo_variants: z.unknown(),
  cover_variants: z.unknown(),
  orderable: z.boolean(),
  tenant_name_bn: z.string(),
  area_bn: z.string().nullable(),
  listed: z.coerce.number(),
});

/** `condition` field values → the Commerce Manager feed's condition (new | used | refurbished). */
const FEED_CONDITION: Record<string, 'new' | 'used' | 'refurbished'> = {
  new: 'new',
  used: 'used',
  old: 'used',
  like_new: 'used',
  refurbished: 'refurbished',
};

/** Our stock → the Commerce Manager feed's availability. */
const FEED_AVAILABILITY: Record<StockStatus, string> = {
  in_stock: 'in stock',
  out_of_stock: 'out of stock',
  on_order: 'preorder',
};

// settings-exempt: the feed's currency code; prices are stored in taka (BDT)
const CURRENCY = 'BDT';

/**
 * The WhatsApp catalog (ADR 056): a store's live products — photo, price,
 * an order link — light enough for a phone on 2G, and never a phone number
 * (ordering goes through POST /stores/:slug/catalog/order/:postId, which
 * records the lead). Also the owner's export in the Meta Commerce Manager
 * feed format.
 */
@Injectable()
export class StoreCatalogService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly stores: StoresRepository,
    private readonly ownership: PostOwnershipService,
    private readonly share: ShareService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /** The host tenant's active store's catalog (public). */
  async catalog(slug: string): Promise<StoreCatalog> {
    const tenantId = this.context.current()?.tenantId;
    if (!tenantId) throw new TenantRequiredException();
    const max = await this.settings.get('store_catalog_page_max', tenantId);
    const found = await this.readOnly(async (tx) => {
      const store = await this.store(tx, sql`s.slug = ${slug}`);
      return store ? { store, products: await this.products(tx, store.id, max) } : undefined;
    });
    if (!found) throw new StoreNotFoundException();
    const { store, products } = found;
    return {
      store: {
        id: store.id,
        tenantId: store.tenant_id,
        slug: store.slug,
        name: { bn: store.name_bn, en: store.name_en },
        description: store.description,
        logo: this.image(store.logo_variants, 'thumb'),
        cover: this.image(store.cover_variants, 'card'),
        orderable: store.orderable,
      },
      products: products.map((p) => ({
        postId: p.id,
        title: p.title,
        price: p.price,
        priceType: p.price_type_code,
        stockStatus: stockStatusOf(p.store_id, p.stock_status_code) ?? 'in_stock',
        photo: this.photo(p),
      })),
      shareImagePath: `/stores/${store.slug}/og.png`,
    };
  }

  /** The catalog link's preview image (WhatsApp, Facebook): the store's share card. */
  async sharePng(slug: string): Promise<Buffer> {
    if (!this.context.current()?.tenantId) throw new TenantRequiredException();
    const store = await this.readOnly((tx) => this.store(tx, sql`s.slug = ${slug}`));
    if (!store) throw new StoreNotFoundException();
    const cover = parseVariants(store.cover_variants) ?? parseVariants(store.logo_variants);
    return storeCardPng(this.storage, {
      id: store.id,
      name: store.name_bn,
      products: store.listed,
      where: store.area_bn ?? store.tenant_name_bn,
      tenantName: store.tenant_name_bn,
      coverKey: cover?.full.key ?? null,
    });
  }

  /** The owner's/managers' export: the Meta Commerce Manager product feed (CSV). */
  async exportCsv(storeId: string): Promise<{ filename: string; body: Buffer }> {
    const tenantId = await this.readOnly((tx) => this.stores.tenantOf(tx, storeId));
    if (!tenantId) throw new StoreNotFoundException();
    const { store, products, codes } = await this.ownership.inTenant(
      tenantId,
      'lookup',
      async () => {
        const result = await this.readOnly(async (tx) => {
          const row = await this.stores.find(tx, storeId);
          if (!row || !storeCan(row.my_role, 'edit_settings')) {
            throw new StoreActionForbiddenException('export_catalog', row?.my_role ?? null);
          }
          const store = await this.store(tx, sql`s.id = ${storeId}::uuid`);
          if (!store) throw new StoreNotFoundException();
          return { store, products: await this.products(tx, store.id, null) };
        });
        // Share links are the product pages' stable public URLs (made on first use).
        const codes = new Map<string, string>();
        for (const p of result.products) codes.set(p.id, await this.share.codeFor(p.id));
        return { ...result, codes };
      },
    );

    const header = [
      'id',
      'title',
      'description',
      'availability',
      'condition',
      'price',
      'link',
      'image_link',
      'brand',
    ];
    const rows = products.map((p) => [
      p.id,
      p.title,
      (p.description ?? p.title).replace(/\s+/g, ' ').trim(),
      FEED_AVAILABILITY[stockStatusOf(p.store_id, p.stock_status_code) ?? 'in_stock'],
      FEED_CONDITION[p.condition ?? ''] ?? 'new',
      p.price ? `${p.price} ${CURRENCY}` : '',
      this.share.urlFor(store.tenant_slug, codes.get(p.id)!),
      this.image(p.variants, 'full')?.url ?? '',
      store.name_en ?? store.name_bn,
    ]);
    return {
      filename: `catalog-${store.slug}.csv`,
      body: Buffer.from(toCsv([header, ...rows]), 'utf8'),
    };
  }

  private async store(tx: DatabaseTransaction, where: ReturnType<typeof sql>) {
    const rows = await tx.execute(sql`
      select s.id, s.tenant_id, t.slug as tenant_slug, s.slug, s.name_bn, s.name_en, s.description,
             logo.variants as logo_variants, cover.variants as cover_variants,
             (s.whatsapp_e164 is not null or s.phone_e164 is not null) as orderable,
             t.name_bn as tenant_name_bn, coalesce(l.name_bn, ga.name_bn) as area_bn,
             (select count(*) from public.posts p
              where p.tenant_id = s.tenant_id and p.store_id = s.id
                and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
             ) as listed
      from public.stores s
      join public.tenants t on t.id = s.tenant_id
      left join public.places pl on pl.tenant_id = s.tenant_id and pl.id = s.place_id
      left join public.localities l on l.tenant_id = s.tenant_id and l.id = coalesce(s.locality_id, pl.locality_id)
      left join public.geo_areas ga on ga.id = pl.geo_area_id
      left join public.media_assets logo on logo.tenant_id = s.tenant_id and logo.id = s.logo_media_id
        and logo.status_code = 'ready' and logo.visibility_code = 'public'
      left join public.media_assets cover on cover.tenant_id = s.tenant_id and cover.id = s.cover_media_id
        and cover.status_code = 'ready' and cover.visibility_code = 'public'
      where s.tenant_id = public.current_tenant_id() and ${where}
        and s.status_code = 'active' and s.deleted_at is null`);
    return z
      .array(STORE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** The store's listed posts, newest first, each with its first public photo (all of them: limit null). */
  private async products(
    tx: DatabaseTransaction,
    storeId: string,
    limit: number | null,
  ): Promise<ProductRow[]> {
    const rows = await tx.execute(sql`
      select p.id, p.title, p.description, p.price::text as price, p.price_type_code,
             p.fields ->> 'condition' as condition, p.store_id, p.stock_status_code,
             cover.variants, cover.thumbhash
      from public.posts p
      left join lateral (
        select m.variants, m.thumbhash
        from public.media_attachments a
        join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
        where a.tenant_id = p.tenant_id and a.post_id = p.id
          and m.status_code = 'ready' and m.visibility_code = 'public'
        order by a.sort_order limit 1
      ) cover on true
      where p.tenant_id = public.current_tenant_id() and p.store_id = ${storeId}::uuid
        and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
      order by coalesce(p.bumped_at, p.published_at) desc nulls last, p.id desc
      ${limit === null ? sql`` : sql`limit ${limit}`}`);
    return z.array(PRODUCT_ROW).parse([...rows]);
  }

  private photo(p: ProductRow): StoreCatalog['products'][number]['photo'] {
    const variants = parseVariants(p.variants);
    return variants
      ? {
          url: this.storage.getPublicUrl('media', variants.card.key),
          width: variants.card.width,
          height: variants.card.height,
          thumbhash: p.thumbhash,
        }
      : null;
  }

  private image(raw: unknown, variant: 'thumb' | 'card' | 'full'): { url: string } | null {
    const variants = parseVariants(raw);
    return variants ? { url: this.storage.getPublicUrl('media', variants[variant].key) } : null;
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}

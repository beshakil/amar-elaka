import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { LISTING_STATES } from './dto/seo.dto';

const STATUS_ROW = z.object({
  state: z.enum(LISTING_STATES),
  tenant_id: z.string(),
  tenant_slug: z.string(),
  title: z.string().nullable(),
  sold_at: z.coerce.date().nullable(),
  updated_at: z.coerce.date(),
});
export type StatusRow = z.infer<typeof STATUS_ROW>;

const OG_ROW = z.object({
  title: z.string(),
  price: z.string().nullable(),
  price_type_code: z.string().nullable(),
  status_code: z.string(),
  updated_at: z.coerce.date(),
  area_bn: z.string().nullable(),
  tenant_name_bn: z.string(),
  cover_variants: z.unknown(),
});
export type OgRow = z.infer<typeof OG_ROW>;

const AREA_ROW = z.object({
  id: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});
export type AreaRow = z.infer<typeof AREA_ROW>;

const CATEGORY_TREE_ROW = z.object({
  slug: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  ids: z.array(z.string()),
});
export type CategoryTreeRow = z.infer<typeof CATEGORY_TREE_ROW>;

/** The tenant's posts a sitemap lists: listed ones, and sold ones still inside the index window. */
const sitemapPostsWhere = (soldNoindexDays: number) => sql`
  p.tenant_id = public.current_tenant_id()
  and (public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
       or (p.status_code = 'sold' and p.scrubbed_at is null
           and public.post_is_viewable(p.status_code, p.deleted_at, p.hidden_by_owner)
           and p.sold_at > now() - make_interval(days => ${soldNoindexDays})))`;

/**
 * SQL for the public web pages (ADR 039). Everything but the status runs in
 * the host's tenant under the public-read policies; the status needs
 * post_public_status (0033) to tell gone from never-public.
 */
@Injectable()
export class SeoRepository {
  async listingStatus(tx: DatabaseTransaction, postId: string): Promise<StatusRow | undefined> {
    const rows = await tx.execute(sql`
      select state, tenant_id, tenant_slug, title, sold_at, updated_at
      from public.post_public_status(${postId}::uuid)`);
    return z
      .array(STATUS_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** What the share image shows, for a public post of the context tenant. */
  async ogData(tx: DatabaseTransaction, postId: string): Promise<OgRow | undefined> {
    const rows = await tx.execute(sql`
      select p.title, p.price::text as price, p.price_type_code, p.status_code, p.updated_at,
             coalesce(l.name_bn, ga.name_bn) as area_bn, t.name_bn as tenant_name_bn,
             cover.variants as cover_variants
      from public.posts p
      join public.tenants t on t.id = p.tenant_id
      left join public.localities l on l.tenant_id = p.tenant_id and l.id = p.locality_id
      left join public.geo_areas ga on ga.id = p.geo_area_id
      left join lateral (
        select m.variants from public.media_attachments a
        join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
        where a.tenant_id = p.tenant_id and a.post_id = p.id
          and m.status_code = 'ready' and m.visibility_code = 'public'
        order by a.sort_order limit 1
      ) cover on true
      where p.id = ${postId}::uuid and p.scrubbed_at is null
        and public.post_is_viewable(p.status_code, p.deleted_at, p.hidden_by_owner)`);
    return z
      .array(OG_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async countSitemapPosts(tx: DatabaseTransaction, soldNoindexDays: number): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::int as n from public.posts p where ${sitemapPostsWhere(soldNoindexDays)}`);
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  async sitemapPosts(
    tx: DatabaseTransaction,
    soldNoindexDays: number,
    offset: number,
    limit: number,
  ): Promise<{ id: string; title: string; updated_at: Date }[]> {
    const rows = await tx.execute(sql`
      select p.id, p.title, p.updated_at from public.posts p
      where ${sitemapPostsWhere(soldNoindexDays)}
      order by p.id
      offset ${offset} limit ${limit}`);
    return z
      .array(z.object({ id: z.string(), title: z.string(), updated_at: z.coerce.date() }))
      .parse([...rows]);
  }

  async countStores(tx: DatabaseTransaction): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::int as n from public.stores s
      where s.tenant_id = public.current_tenant_id() and s.status_code = 'active' and s.deleted_at is null`);
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  async sitemapStores(
    tx: DatabaseTransaction,
    offset: number,
    limit: number,
  ): Promise<{ slug: string; updated_at: Date }[]> {
    const rows = await tx.execute(sql`
      select s.slug, s.updated_at from public.stores s
      where s.tenant_id = public.current_tenant_id() and s.status_code = 'active' and s.deleted_at is null
      order by s.id
      offset ${offset} limit ${limit}`);
    return z.array(z.object({ slug: z.string(), updated_at: z.coerce.date() })).parse([...rows]);
  }

  // ---- category + area landing pages (ADR 042) ---------------------------

  /** The host tenant's active areas, with their URL slug and centre. */
  async activeAreas(tx: DatabaseTransaction): Promise<AreaRow[]> {
    const rows = await tx.execute(sql`
      select l.id, l.slug, l.name_bn, l.name_en,
             st_y(l.center::geometry) as lat, st_x(l.center::geometry) as lng
      from public.localities l
      where l.tenant_id = public.current_tenant_id() and l.is_active and l.deleted_at is null
      order by l.sort_order, l.slug`);
    return z.array(AREA_ROW).parse([...rows]);
  }

  /**
   * The host tenant's enabled categories, each with its active descendants'
   * ids — the same tree a search for the category covers (resolveCategory).
   */
  async enabledCategoryTrees(tx: DatabaseTransaction): Promise<CategoryTreeRow[]> {
    const rows = await tx.execute(sql`
      with recursive tree as (
        select c.id as root_id, c.id from public.categories c
        join public.tenant_categories tc
          on tc.category_id = c.id and tc.tenant_id = public.current_tenant_id() and tc.is_enabled
        where c.deleted_at is null and c.is_active
        union all
        select t.root_id, c.id from public.categories c
        join tree t on c.parent_id = t.id
        where c.deleted_at is null and c.is_active
      )
      select r.slug, r.name_bn, r.name_en, array_agg(distinct tree.id::text) as ids
      from tree join public.categories r on r.id = tree.root_id
      group by r.id, r.slug, r.name_bn, r.name_en
      order by r.slug`);
    return z.array(CATEGORY_TREE_ROW).parse([...rows]);
  }
}

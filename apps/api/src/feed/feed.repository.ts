import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  parseFieldSchema,
  parseUiSchema,
  type CategoryFieldDefinition,
  type FieldFilter,
} from '../categories/field-schema';
import type { DatabaseTransaction } from '../database/database.client';

/**
 * Feed reads. Two kinds, never mixed in one transaction:
 *  - ranking: feed_posts / feed_stores / feed_landmarks (0030), SECURITY
 *    DEFINER functions that return ids, scores and distances across tenants;
 *  - cards: plain SELECTs run in the *owning* tenant's context as `anon`, so
 *    the public-read policies decide what a card may show (0023 pattern).
 * No SELECT *, every row parsed with zod.
 */

export interface Origin {
  lat: number;
  lng: number;
}

export interface FeedCategory {
  id: string;
  /** The category and its active descendants. */
  ids: string[];
  /** Of `ids`, the shippable ones (the country scope uses these). */
  shippableIds: string[];
  definition: CategoryFieldDefinition | null;
}

export interface RankParams {
  w_distance: number;
  w_recency: number;
  w_boost: number;
  w_trust: number;
  w_completeness: number;
  distance_half_km: number;
  recency_half_life_hours: number;
  photo_target: number;
  trust_default: number;
}

export interface RankedPost {
  id: string;
  tenant_id: string;
  score: number;
  distance_m: number | null;
  is_boosted: boolean;
  is_highlighted: boolean;
}

export interface NearbyRow {
  id: string;
  tenant_id: string;
  distance_m: number;
}

const rankedPost = z.object({
  id: z.string(),
  tenant_id: z.string(),
  score: z.number(),
  distance_m: z.number().nullable(),
  is_boosted: z.boolean(),
  is_highlighted: z.boolean(),
});
const nearbyRow = z.object({ id: z.string(), tenant_id: z.string(), distance_m: z.number() });

const nullableText = z.string().nullable();

export const postCardRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  title: z.string(),
  price: nullableText,
  price_type_code: nullableText,
  created_at: z.coerce.date(),
  area_bn: nullableText,
  area_en: nullableText,
  store_verified: z.boolean().nullable(),
  cover_thumbhash: nullableText,
  cover_variants: z.unknown(),
});
export type PostCardRow = z.infer<typeof postCardRow>;

export const storeCardRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: nullableText,
  is_verified: z.boolean(),
  rating_avg: z.coerce.number().nullable(),
  cover_thumbhash: nullableText,
  cover_variants: z.unknown(),
  open_state: nullableText,
  open_changes_at: z.coerce.date().nullable(),
});
export type StoreCardRow = z.infer<typeof storeCardRow>;

export const landmarkCardRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: nullableText,
  category_slug: z.string(),
  category_name_bn: z.string(),
  category_name_en: z.string(),
  open_state: nullableText,
  open_changes_at: z.coerce.date().nullable(),
});
export type LandmarkCardRow = z.infer<typeof landmarkCardRow>;

const bazarRow = z.object({
  price_date: z.string(),
  commodity_code: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  unit_code: z.string(),
  min_price: z.string(),
  max_price: z.string(),
});
export type BazarRow = z.infer<typeof bazarRow>;

const hotlineRow = z.object({
  service_type_code: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  dial_string: z.string(),
});
export type HotlineRow = z.infer<typeof hotlineRow>;

function point(origin: Origin): SQL {
  return sql`st_setsrid(st_makepoint(${origin.lng}, ${origin.lat}), 4326)::geography`;
}

function uuidArray(ids: readonly string[] | null): SQL {
  return ids === null ? sql`null::uuid[]` : sql`${`{${ids.join(',')}}`}::uuid[]`;
}

@Injectable()
export class FeedRepository {
  async resolveCategory(tx: DatabaseTransaction, slug: string): Promise<FeedCategory | undefined> {
    const rows = await tx.execute(sql`
      with recursive tree as (
        select c.id, c.is_shippable, 0 as depth from public.categories c
        where c.slug = ${slug} and c.deleted_at is null and c.is_active
        union all
        select c.id, c.is_shippable, t.depth + 1 from public.categories c
        join tree t on c.parent_id = t.id
        where c.deleted_at is null and c.is_active
      )
      select t.id, t.depth, t.is_shippable,
             s.json_schema, s.ui_schema, s.filterable_fields, s.searchable_fields, s.analytics_fields
      from tree t
      left join public.category_field_schemas s
        on t.depth = 0 and s.category_id = t.id and s.status_code = 'published'
      order by t.depth, t.id`);
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          depth: z.coerce.number(),
          is_shippable: z.boolean(),
          json_schema: z.unknown(),
          ui_schema: z.unknown(),
          filterable_fields: z.array(z.string()).nullable(),
          searchable_fields: z.array(z.string()).nullable(),
          analytics_fields: z.array(z.string()).nullable(),
        }),
      )
      .parse([...rows]);
    const root = parsed[0];
    if (root === undefined) return undefined;
    const definition: CategoryFieldDefinition | null =
      root.json_schema === null || root.json_schema === undefined
        ? null
        : {
            jsonSchema: parseFieldSchema(root.json_schema),
            uiSchema: parseUiSchema(root.ui_schema),
            filterableFields: root.filterable_fields ?? [],
            searchableFields: root.searchable_fields ?? [],
            analyticsFields: root.analytics_fields ?? [],
          };
    return {
      id: root.id,
      ids: parsed.map((r) => r.id),
      shippableIds: parsed.filter((r) => r.is_shippable).map((r) => r.id),
      definition,
    };
  }

  /** The tenant's map centre: the origin when the viewer shares no location. */
  async tenantCenter(tx: DatabaseTransaction, tenantId: string): Promise<Origin | undefined> {
    const rows = await tx.execute(sql`
      select st_y(t.map_center::geometry) as lat, st_x(t.map_center::geometry) as lng
      from public.tenants t
      where t.id = ${tenantId}::uuid and t.map_center is not null`);
    return z.array(z.object({ lat: z.number(), lng: z.number() })).parse([...rows])[0];
  }

  async rankPosts(
    tx: DatabaseTransaction,
    q: {
      origin: Origin;
      radiusKm: number | null;
      categoryIds: readonly string[] | null;
      shippableOnly: boolean;
      fieldFilters: readonly FieldFilter[];
      boostPlacement: 'home_featured' | 'category_top';
      rank: RankParams;
      asOf: Date;
      after: { score: number; id: string } | null;
      limit: number;
    },
  ): Promise<RankedPost[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, score, distance_m, is_boosted, is_highlighted
      from public.feed_posts(
        ${point(q.origin)},
        ${q.radiusKm}::double precision,
        ${uuidArray(q.categoryIds)},
        ${q.shippableOnly},
        ${q.fieldFilters.length > 0 ? JSON.stringify(q.fieldFilters) : null}::text::jsonb,
        ${q.boostPlacement},
        ${JSON.stringify(q.rank)}::text::jsonb,
        ${q.asOf.toISOString()}::timestamptz,
        ${q.after?.score ?? null}::double precision,
        ${q.after?.id ?? null}::uuid,
        ${q.limit})`);
    return z.array(rankedPost).parse([...rows]);
  }

  async nearestStores(
    tx: DatabaseTransaction,
    q: {
      origin: Origin;
      radiusKm: number;
      after: { distance: number; id: string } | null;
      limit: number;
      /** Only stores open now (is_open_at, ADR 049). */
      openOnly: boolean;
    },
  ): Promise<NearbyRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, distance_m
      from public.feed_stores(
        ${point(q.origin)}, ${q.radiusKm}::double precision,
        ${q.after?.distance ?? null}::double precision, ${q.after?.id ?? null}::uuid, ${q.limit},
        ${q.openOnly})`);
    return z.array(nearbyRow).parse([...rows]);
  }

  async landmarks(
    tx: DatabaseTransaction,
    origin: Origin,
    limit: number,
    openOnly: boolean,
  ): Promise<NearbyRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, distance_m from public.feed_landmarks(${point(origin)}, ${limit}, ${openOnly})`);
    return z.array(nearbyRow).parse([...rows]);
  }

  // ---- cards: run in the owning tenant's context --------------------------

  async postCards(tx: DatabaseTransaction, ids: readonly string[]): Promise<PostCardRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select p.id, p.tenant_id, p.title, p.price::text as price, p.price_type_code, p.created_at,
             coalesce(l.name_bn, ga.name_bn) as area_bn, coalesce(l.name_en, ga.name_en) as area_en,
             st.is_verified as store_verified,
             cover.thumbhash as cover_thumbhash, cover.variants as cover_variants
      from public.posts p
      left join public.localities l on l.tenant_id = p.tenant_id and l.id = p.locality_id
      left join public.geo_areas ga on ga.id = p.geo_area_id
      left join public.stores st on st.tenant_id = p.tenant_id and st.id = p.store_id
      left join lateral (
        select m.thumbhash, m.variants
        from public.media_attachments a
        join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
        where a.tenant_id = p.tenant_id and a.post_id = p.id
          and m.status_code = 'ready' and m.visibility_code = 'public'
        order by a.sort_order
        limit 1
      ) cover on true
      where p.id = any (${uuidArray(ids)})
        and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())`);
    return z.array(postCardRow).parse([...rows]);
  }

  /** Which of these posts the caller saved (their own saved_posts rows are visible in any tenant). */
  async savedPostIds(tx: DatabaseTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx.execute(sql`
      select post_id from public.saved_posts
      where user_id = public.current_user_id() and post_id = any (${uuidArray(ids)})`);
    return new Set(
      z
        .array(z.object({ post_id: z.string() }))
        .parse([...rows])
        .map((r) => r.post_id),
    );
  }

  async storeCards(tx: DatabaseTransaction, ids: readonly string[]): Promise<StoreCardRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select s.id, s.tenant_id, s.slug, s.name_bn, s.name_en, s.is_verified, s.rating_avg,
             m.thumbhash as cover_thumbhash, m.variants as cover_variants,
             (o.x).state as open_state, (o.x).changes_at as open_changes_at
      from public.stores s
      cross join lateral (select public.is_open_at('store', s.id, now()) as x) o
      left join public.media_assets m
        on m.tenant_id = s.tenant_id and m.id = coalesce(s.cover_media_id, s.logo_media_id)
       and m.status_code = 'ready' and m.visibility_code = 'public'
      where s.id = any (${uuidArray(ids)}) and s.status_code = 'active'`);
    return z.array(storeCardRow).parse([...rows]);
  }

  async landmarkCards(tx: DatabaseTransaction, ids: readonly string[]): Promise<LandmarkCardRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select pl.id, pl.tenant_id, pl.slug, pl.name_bn, pl.name_en,
             c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
             (o.x).state as open_state, (o.x).changes_at as open_changes_at
      from public.places pl
      cross join lateral (select public.is_open_at('place', pl.id, now()) as x) o
      join public.categories c on c.id = pl.category_id
      where pl.id = any (${uuidArray(ids)})`);
    return z.array(landmarkCardRow).parse([...rows]);
  }

  // ---- info cards: the request tenant's own local information -------------

  /** Today's published prices (the tenant's zone), one row per commodity and unit across markets. */
  async bazarToday(tx: DatabaseTransaction, limit: number): Promise<BazarRow[]> {
    const rows = await tx.execute(sql`
      select bp.price_date::text as price_date, c.code as commodity_code, c.name_bn, c.name_en,
             bp.unit_code, min(bp.min_price)::text as min_price, max(bp.max_price)::text as max_price
      from public.bazar_prices bp
      join public.bazar_commodities c on c.id = bp.commodity_id
      where bp.status_code = 'published'
        -- Today in the tenant's own zone (tenants.timezone), never an assumed one.
        and bp.price_date = (select (now() at time zone t.timezone)::date
                             from public.tenants t where t.id = bp.tenant_id)
      group by bp.price_date, c.id, c.code, c.name_bn, c.name_en, c.sort_order, bp.unit_code
      order by c.sort_order, c.code, bp.unit_code
      limit ${limit}`);
    return z.array(bazarRow).parse([...rows]);
  }

  async hotlines(tx: DatabaseTransaction, limit: number): Promise<HotlineRow[]> {
    const rows = await tx.execute(sql`
      select h.service_type_code, h.name_bn, h.name_en, h.dial_string
      from public.national_hotlines h
      where h.is_active
      order by h.sort_order, h.id
      limit ${limit}`);
    return z.array(hotlineRow).parse([...rows]);
  }
}

import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  parseFieldSchema,
  parseUiSchema,
  type FieldSchema,
  type UiSchema,
} from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import type { SearchType } from '../search.types';
import type { PlaceRow, PostRow, StoreRow } from './document-builder';

/**
 * The SQL side of indexing. Every method runs inside a transaction opened by
 * the caller as the `system` role, which RLS treats as platform admin (0002)
 * — the indexer reads every tenant's public rows through the normal
 * policies, never around them.
 *
 * "Indexable" is decided here, in one place per type, and mirrors what the
 * public may see (schema.md §4.2, §4.4, §5.1): live / active / published,
 * not deleted, hidden or scrubbed, category enabled in the tenant, author
 * not banned. A sold post is not live, so it leaves search; a scrubbed one
 * (ADR 006) leaves it whatever its status.
 */

export function uuidList(ids: readonly string[]): SQL {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

const TABLES: Readonly<Record<SearchType, SQL>> = {
  posts: sql.raw('public.posts'),
  stores: sql.raw('public.stores'),
  places: sql.raw('public.places'),
};

const nullableText = z.string().nullable();
const baseRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  indexable: z.boolean(),
  description: nullableText,
  category_id: nullableText,
  category_slug: nullableText,
  category_name_bn: nullableText,
  category_name_en: nullableText,
  locality_id: nullableText,
  area_name_bn: nullableText,
  area_name_en: nullableText,
  lat: z.coerce.number().nullable(),
  lng: z.coerce.number().nullable(),
  published_at: z.coerce.number().int(),
  is_boosted: z.boolean(),
  is_shippable: z.boolean(),
  cover_thumb_key: nullableText,
  cover_thumbhash: nullableText,
  rating_avg: nullableText,
  json_schema: z.unknown(),
  ui_schema: z.unknown(),
  filterable_fields: z.array(z.string()).nullable(),
  searchable_fields: z.array(z.string()).nullable(),
  fields: z.record(z.unknown()),
});

const postRow = baseRow.extend({
  title: z.string(),
  price: nullableText,
  // Not z.coerce: that would turn a NULL (never expires) into 0.
  expires_at: z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]).nullable(),
});
const storeRow = baseRow.extend({
  name_bn: z.string(),
  name_en: nullableText,
  slug: z.string(),
  is_verified: z.boolean(),
});
const placeRow = baseRow.extend({
  name_bn: z.string(),
  name_en: nullableText,
  slug: z.string(),
  is_landmark: z.boolean(),
});

function schemaOrNull<T>(parse: (v: unknown) => T, value: unknown): T | null {
  if (value === null || value === undefined) return null;
  try {
    return parse(value);
  } catch {
    // A row pinned to an unreadable version is still indexed, just without custom fields.
    return null;
  }
}

function withSchema<T extends z.infer<typeof baseRow>>(row: T) {
  const jsonSchema = schemaOrNull<FieldSchema>(parseFieldSchema, row.json_schema);
  return {
    ...row,
    json_schema: jsonSchema,
    ui_schema: jsonSchema === null ? null : schemaOrNull<UiSchema>(parseUiSchema, row.ui_schema),
    filterable_fields: row.filterable_fields ?? [],
    searchable_fields: row.searchable_fields ?? [],
  };
}

/**
 * A post counts as boosted in search exactly as in the feed (feed_posts step
 * 1, migration 0030, with the category placement it uses for a category
 * page): an active `category_top` boost of a live post, and only the first
 * boost_slots_per_category of its tenant + category by start (the tenant's
 * override, else the platform's). Extra boosts rank as organic. Runs with
 * `p` = the post and `ts` = its tenant_settings row in scope.
 */
const CAPPED_BOOST = sql.raw(`exists (
          select 1
          from (
            select b.post_id,
                   row_number() over (order by b.starts_at, b.id) as slot
            from public.boosts b
            join public.boost_types bt on bt.id = b.boost_type_id
            join public.posts bp on bp.tenant_id = b.tenant_id and bp.id = b.post_id
            where b.tenant_id = p.tenant_id and bp.category_id = p.category_id
              and b.status_code = 'active' and b.post_id is not null
              and b.starts_at <= now() and b.ends_at > now()
              and bt.placement_code = 'category_top'
              and public.post_is_listed(bp.status_code, bp.deleted_at, bp.scrubbed_at, bp.hidden_by_owner, bp.store_hidden, bp.expires_at, now())
          ) ranked
          where ranked.post_id = p.id
            and ranked.slot <= coalesce(
              (ts.setting_overrides ->> 'boost_slots_per_category')::integer,
              (select (ps.value #>> '{}')::integer from public.platform_settings ps
               where ps.key = 'boost_slots_per_category'))
        )`);

/** The shared tail of each loader: area names, geo point, cover photo. */
const GEO_POINT = sql.raw('st_y(g.pt::geometry) as lat, st_x(g.pt::geometry) as lng');

export interface LoadedRows<T> {
  /** Rows that belong in the index. */
  indexable: T[];
  /** Requested ids that are gone or no longer public: remove from the index. */
  removed: string[];
}

function split<T extends { id: string; indexable: boolean }>(
  ids: readonly string[],
  rows: T[],
): LoadedRows<T> {
  const indexable = rows.filter((r) => r.indexable);
  const keep = new Set(indexable.map((r) => r.id));
  return { indexable, removed: ids.filter((id) => !keep.has(id)) };
}

@Injectable()
export class SearchDocumentsRepository {
  async loadPosts(tx: DatabaseTransaction, ids: readonly string[]): Promise<LoadedRows<PostRow>> {
    if (ids.length === 0) return { indexable: [], removed: [] };
    const rows = await tx.execute(sql`
      select
        p.id, p.tenant_id, p.title, p.description, p.fields, p.price::text as price,
        (public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
          and c.deleted_at is null and c.is_active
          and coalesce(tc.is_enabled, false)
          and m.ban_severity_code is distinct from 'banned') as indexable,
        p.category_id, c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
        s.json_schema, s.ui_schema, s.filterable_fields, s.searchable_fields,
        p.locality_id,
        coalesce(l.name_bn, ga.name_bn) as area_name_bn,
        coalesce(l.name_en, ga.name_en) as area_name_en,
        ${GEO_POINT},
        extract(epoch from coalesce(p.bumped_at, p.published_at, p.created_at))::bigint as published_at,
        extract(epoch from p.expires_at)::bigint as expires_at,
        ${CAPPED_BOOST} as is_boosted,
        c.is_shippable,
        cover.thumb_key as cover_thumb_key, cover.thumbhash as cover_thumbhash,
        null::text as rating_avg
      from public.posts p
      join public.categories c on c.id = p.category_id
      join public.category_field_schemas s on s.id = p.field_schema_id
      left join public.tenant_categories tc on tc.tenant_id = p.tenant_id and tc.category_id = p.category_id
      left join public.localities l
        on l.tenant_id = p.tenant_id and l.id = p.locality_id and l.deleted_at is null
      left join public.geo_areas ga on ga.id = coalesce(p.geo_area_id, p.geo_area_id_coarse)
      left join public.tenant_members m on m.tenant_id = p.tenant_id and m.id = p.author_member_id
      left join public.tenant_settings ts on ts.tenant_id = p.tenant_id
      cross join lateral (select coalesce(p.location, l.center, ga.centroid) as pt) g
      left join lateral (
        select ma.variants -> 'thumb' ->> 'key' as thumb_key, ma.thumbhash
        from public.media_attachments att
        join public.media_assets ma on ma.tenant_id = att.tenant_id and ma.id = att.media_asset_id
        where att.tenant_id = p.tenant_id and att.post_id = p.id
          and ma.kind_code = 'image' and ma.status_code = 'ready' and ma.deleted_at is null
        order by att.sort_order, att.id
        limit 1
      ) cover on true
      where p.id in ${uuidList(ids)}`);
    return split(
      ids,
      z
        .array(postRow)
        .parse([...rows])
        .map(withSchema),
    );
  }

  async loadStores(tx: DatabaseTransaction, ids: readonly string[]): Promise<LoadedRows<StoreRow>> {
    if (ids.length === 0) return { indexable: [], removed: [] };
    const rows = await tx.execute(sql`
      select
        st.id, st.tenant_id, st.name_bn, st.name_en, st.description, st.slug, st.is_verified,
        (st.status_code = 'active'
          and st.deleted_at is null
          and m.ban_severity_code is distinct from 'banned') as indexable,
        coalesce(st.category_id, pl.category_id) as category_id, c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
        null::jsonb as json_schema, null::jsonb as ui_schema,
        null::text[] as filterable_fields, null::text[] as searchable_fields, '{}'::jsonb as fields,
        st.locality_id,
        coalesce(l.name_bn, ga.name_bn) as area_name_bn,
        coalesce(l.name_en, ga.name_en) as area_name_en,
        ${GEO_POINT},
        extract(epoch from st.created_at)::bigint as published_at,
        exists (
          select 1 from public.boosts b
          where b.tenant_id = st.tenant_id and b.store_id = st.id
            and b.status_code = 'active' and b.starts_at <= now() and b.ends_at > now()
        ) as is_boosted,
        false as is_shippable,
        cover.thumb_key as cover_thumb_key, cover.thumbhash as cover_thumbhash,
        st.rating_avg::text as rating_avg
      from public.stores st
      join public.tenants t on t.id = st.tenant_id
      left join public.places pl on pl.tenant_id = st.tenant_id and pl.id = st.place_id and pl.deleted_at is null
      -- 0050: a store's own category; claimed stores made before it fall back to the pin's.
      left join public.categories c on c.id = coalesce(st.category_id, pl.category_id) and c.deleted_at is null
      left join public.localities l
        on l.tenant_id = st.tenant_id and l.id = st.locality_id and l.deleted_at is null
      left join public.geo_areas ga on ga.id = t.geo_area_id
      left join public.tenant_members m on m.tenant_id = st.tenant_id and m.id = st.owner_member_id
      cross join lateral (select coalesce(st.location, pl.location, l.center) as pt) g
      left join lateral (
        select ma.variants -> 'thumb' ->> 'key' as thumb_key, ma.thumbhash
        from public.media_assets ma
        where ma.tenant_id = st.tenant_id and ma.id = coalesce(st.logo_media_id, st.cover_media_id)
          and ma.status_code = 'ready' and ma.deleted_at is null
      ) cover on true
      where st.id in ${uuidList(ids)}`);
    return split(
      ids,
      z
        .array(storeRow)
        .parse([...rows])
        .map(withSchema),
    );
  }

  async loadPlaces(tx: DatabaseTransaction, ids: readonly string[]): Promise<LoadedRows<PlaceRow>> {
    if (ids.length === 0) return { indexable: [], removed: [] };
    const rows = await tx.execute(sql`
      select
        pl.id, pl.tenant_id, pl.name_bn, pl.name_en, pl.description, pl.slug, pl.is_landmark, pl.fields,
        (pl.status_code in ('published', 'temporarily_closed')
          and pl.deleted_at is null
          and c.deleted_at is null and c.is_active) as indexable,
        pl.category_id, c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
        s.json_schema, s.ui_schema, s.filterable_fields, s.searchable_fields,
        pl.locality_id,
        coalesce(l.name_bn, ga.name_bn) as area_name_bn,
        coalesce(l.name_en, ga.name_en) as area_name_en,
        ${GEO_POINT},
        extract(epoch from pl.created_at)::bigint as published_at,
        false as is_boosted,
        false as is_shippable,
        cover.thumb_key as cover_thumb_key, cover.thumbhash as cover_thumbhash,
        pl.rating_avg::text as rating_avg
      from public.places pl
      join public.categories c on c.id = pl.category_id
      left join public.category_field_schemas s on s.id = pl.field_schema_id
      left join public.localities l
        on l.tenant_id = pl.tenant_id and l.id = pl.locality_id and l.deleted_at is null
      left join public.geo_areas ga on ga.id = pl.geo_area_id
      cross join lateral (select pl.location as pt) g
      left join lateral (
        select ma.variants -> 'thumb' ->> 'key' as thumb_key, ma.thumbhash
        from public.media_attachments att
        join public.media_assets ma on ma.tenant_id = att.tenant_id and ma.id = att.media_asset_id
        where att.tenant_id = pl.tenant_id and att.place_id = pl.id
          and ma.kind_code = 'image' and ma.status_code = 'ready' and ma.deleted_at is null
        order by att.sort_order, att.id
        limit 1
      ) cover on true
      where pl.id in ${uuidList(ids)}`);
    return split(
      ids,
      z
        .array(placeRow)
        .parse([...rows])
        .map(withSchema),
    );
  }

  /** Records a successful sync (index write or removal); excluded from the change triggers (0020). */
  async markSynced(
    tx: DatabaseTransaction,
    type: SearchType,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    await tx.execute(
      sql`update ${TABLES[type]} set search_synced_at = now() where id in ${uuidList(ids)}`,
    );
  }

  /**
   * Keyset page of every id of a type (reindex), or only those changed since
   * `changedSince` (the catch-up after an index swap).
   */
  async idsAfter(
    tx: DatabaseTransaction,
    type: SearchType,
    afterId: string | null,
    limit: number,
    changedSince?: Date,
  ): Promise<string[]> {
    const rows = await tx.execute(sql`
      select id from ${TABLES[type]}
      where (${afterId}::uuid is null or id > ${afterId}::uuid)
        and (${changedSince?.toISOString() ?? null}::timestamptz is null
             or updated_at >= ${changedSince?.toISOString() ?? null}::timestamptz)
      order by id
      limit ${limit}`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  /**
   * Safety net for events that never made it (schema.md §4.2 index on
   * search_synced_at): rows changed after their last sync, and not in the
   * last few minutes, which the outbox is still handling.
   */
  async unsyncedIds(
    tx: DatabaseTransaction,
    type: SearchType,
    graceSeconds: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await tx.execute(sql`
      select id from ${TABLES[type]}
      where (search_synced_at is null or search_synced_at < updated_at)
        and updated_at < now() - make_interval(secs => ${graceSeconds})
      order by updated_at
      limit ${limit}`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  /**
   * Fan-out of a change that touches many documents (a category renamed, a
   * member banned, a locality renamed, a category switched off in a tenant).
   */
  async idsInScope(
    tx: DatabaseTransaction,
    type: SearchType,
    scope: ResyncScope,
    afterId: string | null,
    limit: number,
  ): Promise<string[]> {
    const condition = scopeCondition(type, scope);
    if (condition === undefined) return [];
    const rows = await tx.execute(sql`
      select id from ${TABLES[type]} x
      where ${condition}
        and (${afterId}::uuid is null or x.id > ${afterId}::uuid)
      order by x.id
      limit ${limit}`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  /**
   * Posts whose `category_top` boost started or ended since they were last
   * synced, as (tenant, post): a boost window passing changes no row, so no
   * trigger fires. The relay re-syncs each one's category (boost_post scope).
   */
  async boostBoundaryPosts(
    tx: DatabaseTransaction,
    limit: number,
  ): Promise<{ tenant_id: string; post_id: string }[]> {
    const rows = await tx.execute(sql`
      select distinct b.tenant_id, b.post_id
      from public.boosts b
      join public.boost_types bt on bt.id = b.boost_type_id
      join public.posts p on p.tenant_id = b.tenant_id and p.id = b.post_id
      where b.status_code = 'active' and b.post_id is not null
        and bt.placement_code = 'category_top'
        and (   (b.starts_at <= now() and b.starts_at > coalesce(p.search_synced_at, '-infinity'))
             or (b.ends_at <= now() and b.ends_at > coalesce(p.search_synced_at, '-infinity')))
      limit ${limit}`);
    return z.array(z.object({ tenant_id: z.string(), post_id: z.string() })).parse([...rows]);
  }

  /** Locality names and aliases, as extra synonym groups (schema.md §3.1 `aliases`). */
  async localitySynonymGroups(tx: DatabaseTransaction): Promise<string[][]> {
    const rows = await tx.execute(sql`
      select name_bn, name_en, aliases from public.localities
      where deleted_at is null and is_active and (name_en is not null or cardinality(aliases) > 0)`);
    return z
      .array(z.object({ name_bn: z.string(), name_en: nullableText, aliases: z.array(z.string()) }))
      .parse([...rows])
      .map((r) => [r.name_bn, ...(r.name_en === null ? [] : [r.name_en]), ...r.aliases]);
  }
}

export type ResyncScope =
  | { kind: 'category'; categoryId: string }
  | { kind: 'tenant_category'; tenantId: string; categoryId: string }
  | { kind: 'locality'; tenantId: string; localityId: string }
  | { kind: 'member'; tenantId: string; memberId: string }
  | { kind: 'place'; tenantId: string; placeId: string }
  /** A boost of this post changed: its category's boosted posts (and the post) re-sync. */
  | { kind: 'boost_post'; tenantId: string; postId: string }
  /** boost_slots_per_category changed: every post with a boost (in one tenant, or all). */
  | { kind: 'boosted'; tenantId: string | null };

/** Posts `x` holding an active-status `category_top` boost (any window: one may just have ended). */
const HAS_CATEGORY_BOOST = sql.raw(`exists (
      select 1 from public.boosts b
      join public.boost_types bt on bt.id = b.boost_type_id
      where b.tenant_id = x.tenant_id and b.post_id = x.id
        and b.status_code = 'active' and bt.placement_code = 'category_top')`);

function scopeCondition(type: SearchType, scope: ResyncScope): SQL | undefined {
  switch (scope.kind) {
    case 'category':
      if (type === 'stores') {
        return sql`x.place_id in (select id from public.places where category_id = ${scope.categoryId}::uuid)`;
      }
      return sql`x.category_id = ${scope.categoryId}::uuid`;
    case 'tenant_category':
      return type === 'posts'
        ? sql`x.tenant_id = ${scope.tenantId}::uuid and x.category_id = ${scope.categoryId}::uuid`
        : undefined;
    case 'locality':
      return sql`x.tenant_id = ${scope.tenantId}::uuid and x.locality_id = ${scope.localityId}::uuid`;
    case 'member':
      if (type === 'posts') {
        return sql`x.tenant_id = ${scope.tenantId}::uuid and x.author_member_id = ${scope.memberId}::uuid`;
      }
      if (type === 'stores') {
        return sql`x.tenant_id = ${scope.tenantId}::uuid and x.owner_member_id = ${scope.memberId}::uuid`;
      }
      return undefined;
    case 'place':
      // A store takes its category and fallback location from its place.
      return type === 'stores'
        ? sql`x.tenant_id = ${scope.tenantId}::uuid and x.place_id = ${scope.placeId}::uuid`
        : undefined;
    case 'boost_post':
      return type === 'posts'
        ? sql`x.tenant_id = ${scope.tenantId}::uuid
            and x.category_id = (select bp.category_id from public.posts bp
                                 where bp.tenant_id = ${scope.tenantId}::uuid and bp.id = ${scope.postId}::uuid)
            and (x.id = ${scope.postId}::uuid or ${HAS_CATEGORY_BOOST})`
        : undefined;
    case 'boosted':
      return type === 'posts'
        ? sql`(${scope.tenantId}::uuid is null or x.tenant_id = ${scope.tenantId}::uuid)
            and ${HAS_CATEGORY_BOOST}`
        : undefined;
  }
}

import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { toOpenState, type OpenState } from '../../hours/open-state';
import {
  parseFieldSchema,
  parseUiSchema,
  type CategoryFieldDefinition,
} from '../../categories/field-schema';
import { postFieldFilterConditions } from '../../categories/post-field-filters';
import type { FieldFilter } from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import type { SearchType } from '../search.types';
import type { PriceRange } from './filter-builder';

/**
 * Reads for the search API, in the request's own tenant context: RLS
 * applies exactly as for any other request. That is why the Postgres
 * fallback only ever covers the current tenant (no cross-tenant radius
 * discovery without Meilisearch) — the policies decide, not this code.
 */

export interface ResolvedCategory {
  id: string;
  slug: string;
  /** The category and every active descendant: searching "rental" includes its children. */
  ids: string[];
  /** Of `ids`, the shippable ones (the country scope searches only these). */
  shippableIds: string[];
  /** Current published field definition, when the category has custom fields. */
  definition: CategoryFieldDefinition | null;
}

/** An area (locality) of the request tenant, by its URL slug. */
export interface ResolvedArea {
  id: string;
  slug: string;
  name: { bn: string; en: string | null };
  center: { lat: number; lng: number } | null;
}

export interface FallbackRow {
  id: string;
  tenant_id: string;
  name_bn: string | null;
  name_en: string | null;
  description: string | null;
  category_id: string | null;
  category_slug: string | null;
  category_name_bn: string | null;
  category_name_en: string | null;
  lat: number | null;
  lng: number | null;
  distance_m: number | null;
  published_at: Date;
  price: string | null;
  slug: string | null;
}

// settings-exempt: km → metres, a unit conversion
const METRES_PER_KM = 1_000;

const nullableText = z.string().nullable();
const fallbackRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name_bn: nullableText,
  name_en: nullableText,
  description: nullableText,
  category_id: nullableText,
  category_slug: nullableText,
  category_name_bn: nullableText,
  category_name_en: nullableText,
  lat: z.coerce.number().nullable(),
  lng: z.coerce.number().nullable(),
  distance_m: z.coerce.number().nullable(),
  published_at: z.coerce.date(),
  price: nullableText,
  slug: nullableText,
});

/** Postgres regex: any character of the Bengali block. */
const BENGALI_PATTERN = '[\u0980-\u09FF]';

/** ILIKE pattern for a term, with LIKE wildcards in the term escaped. */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function anyTermMatches(columns: SQL[], terms: readonly string[]): SQL {
  if (terms.length === 0) return sql`true`;
  const alternatives = terms.flatMap((term) =>
    columns.map((column) => sql`${column} ilike ${containsPattern(term)}`),
  );
  return sql`(${sql.join(alternatives, sql` or `)})`;
}

function point(origin: { lat: number; lng: number }): SQL {
  return sql`st_setsrid(st_makepoint(${origin.lng}, ${origin.lat}), 4326)::geography`;
}

export interface FallbackQuery {
  terms: readonly string[];
  categoryIds: readonly string[] | null;
  fieldFilters: readonly FieldFilter[];
  /** Where distance is measured from. */
  origin: { lat: number; lng: number } | null;
  /** Null: no radius (the country scope). */
  radiusKm: number | null;
  /** Posts: shippable categories only (the country scope). */
  shippableOnly: boolean;
  /** Posts: price bounds in poisha. */
  price: PriceRange | null;
  /** Posts: one area. */
  localityId: string | null;
  nearestFirst: boolean;
  /** Stores/places: only those open now (is_open_at, ADR 049). */
  openOnly: boolean;
  limit: number;
  offset: number;
}

export interface SearchLogRow {
  tenantId: string;
  userId: string | null;
  searcherHash: string;
  qNormalized: string;
  filtersHash: string;
  resultCount: number;
  categoryId: string | null;
  origin: { lat: number; lng: number } | null;
}

export interface PopularQuery {
  q_normalized: string;
  searchers: number;
  searches: number;
}

export interface ZeroResultQuery {
  q_normalized: string;
  searches: number;
  searchers: number;
  tenants: number;
  last_searched_at: Date;
}

@Injectable()
export class SearchQueryRepository {
  async resolveCategory(
    tx: DatabaseTransaction,
    slug: string,
  ): Promise<ResolvedCategory | undefined> {
    return this.resolveCategoryWhere(tx, sql`c.slug = ${slug}`);
  }

  /** As resolveCategory, by id (a saved search stores the category's id). */
  async resolveCategoryById(
    tx: DatabaseTransaction,
    id: string,
  ): Promise<ResolvedCategory | undefined> {
    return this.resolveCategoryWhere(tx, sql`c.id = ${id}::uuid`);
  }

  private async resolveCategoryWhere(
    tx: DatabaseTransaction,
    rootCondition: SQL,
  ): Promise<ResolvedCategory | undefined> {
    const rows = await tx.execute(sql`
      with recursive tree as (
        select c.id, c.slug, c.is_shippable, 0 as depth from public.categories c
        where ${rootCondition} and c.deleted_at is null and c.is_active
        union all
        select c.id, c.slug, c.is_shippable, t.depth + 1 from public.categories c
        join tree t on c.parent_id = t.id
        where c.deleted_at is null and c.is_active
      )
      select t.id, t.depth, t.is_shippable, t.slug,
             s.json_schema, s.ui_schema, s.filterable_fields, s.searchable_fields, s.analytics_fields
      from tree t
      left join public.category_field_schemas s
        on t.depth = 0 and s.category_id = t.id and s.status_code = 'published'
      order by t.depth`);
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          depth: z.coerce.number(),
          is_shippable: z.boolean(),
          slug: z.string(),
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
      slug: root.slug,
      ids: parsed.map((r) => r.id),
      shippableIds: parsed.filter((r) => r.is_shippable).map((r) => r.id),
      definition,
    };
  }

  /**
   * The tenant's map centre: where discovery is centred when the viewer shares
   * no location (§13.26 — radius, never a tenant filter). Undefined when the
   * tenant isn't visible to this request.
   */
  async tenantCenter(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<{ lat: number; lng: number } | undefined> {
    const rows = await tx.execute(sql`
      select st_y(t.map_center::geometry) as lat, st_x(t.map_center::geometry) as lng
      from public.tenants t
      where t.id = ${tenantId}::uuid`);
    return z.array(z.object({ lat: z.number(), lng: z.number() })).parse([...rows])[0];
  }

  /** An active area of [tenantId] by slug; undefined when there is none. */
  async areaBySlug(
    tx: DatabaseTransaction,
    tenantId: string,
    slug: string,
  ): Promise<ResolvedArea | undefined> {
    const rows = await tx.execute(sql`
      select l.id, l.slug, l.name_bn, l.name_en,
             st_y(l.center::geometry) as lat, st_x(l.center::geometry) as lng
      from public.localities l
      where l.tenant_id = ${tenantId}::uuid and l.slug = ${slug}
        and l.is_active and l.deleted_at is null`);
    const row = z
      .array(
        z.object({
          id: z.string(),
          slug: z.string(),
          name_bn: z.string(),
          name_en: z.string().nullable(),
          lat: z.number().nullable(),
          lng: z.number().nullable(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
    if (!row) return undefined;
    return {
      id: row.id,
      slug: row.slug,
      name: { bn: row.name_bn, en: row.name_en },
      center: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    };
  }

  /** Active categories enabled in the current tenant, for suggestions. */
  async tenantCategories(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<{ slug: string; name_bn: string; name_en: string }[]> {
    const rows = await tx.execute(sql`
      select c.slug, c.name_bn, c.name_en
      from public.categories c
      join public.tenant_categories tc on tc.category_id = c.id
      where tc.tenant_id = ${tenantId}::uuid and tc.is_enabled
        and c.deleted_at is null and c.is_active
      order by tc.sort_order, c.default_sort_order`);
    return z
      .array(z.object({ slug: z.string(), name_bn: z.string(), name_en: z.string() }))
      .parse([...rows]);
  }

  /**
   * One search, in the searcher's own context (insert policy: own or
   * anonymous). The id is drawn first because the searcher may not read the
   * log back, so INSERT … RETURNING would fail its SELECT policy.
   */
  async logQuery(tx: DatabaseTransaction, row: SearchLogRow): Promise<string> {
    const ids = await tx.execute(sql`select public.uuid_generate_v7() as id`);
    const id = z.array(z.object({ id: z.string() })).parse([...ids])[0]!.id;
    await tx.execute(sql`
      insert into public.search_queries
        (id, tenant_id, user_id, searcher_hash, q_normalized, filters_hash, result_count,
         category_id, origin)
      values (${id}::uuid, ${row.tenantId}::uuid, ${row.userId}::uuid, ${row.searcherHash},
              ${row.qNormalized}, ${row.filtersHash}, ${row.resultCount}, ${row.categoryId}::uuid,
              ${row.origin === null ? null : `SRID=4326;POINT(${row.origin.lng} ${row.origin.lat})`}::geography)`);
    return id;
  }

  /** record_search_click (0034): true when the click was recorded. */
  async recordClick(
    tx: DatabaseTransaction,
    searchId: string,
    postId: string,
    windowMinutes: number,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      select public.record_search_click(${searchId}::uuid, ${postId}::uuid, ${windowMinutes}) as recorded`);
    return z.array(z.object({ recorded: z.boolean() })).parse([...rows])[0]!.recorded;
  }

  /** The current tenant's top queries (search_popular_queries, 0034): aggregates only. */
  async popularQueries(
    tx: DatabaseTransaction,
    since: Date,
    minSearchers: number,
    limit: number,
  ): Promise<PopularQuery[]> {
    const rows = await tx.execute(sql`
      select q_normalized, searchers, searches
      from public.search_popular_queries(${since.toISOString()}::timestamptz, ${minSearchers}, ${limit})`);
    return z
      .array(
        z.object({
          q_normalized: z.string(),
          searchers: z.coerce.number().int(),
          searches: z.coerce.number().int(),
        }),
      )
      .parse([...rows]);
  }

  /**
   * Zero-result queries across every tenant since `since`, most-searched
   * first (the synonym workflow). Platform / system context only: the
   * search_queries policies return nothing to anyone else.
   */
  async zeroResultQueries(
    tx: DatabaseTransaction,
    since: Date,
    limit: number,
  ): Promise<ZeroResultQuery[]> {
    const rows = await tx.execute(sql`
      select q.q_normalized, count(*) as searches, count(distinct q.searcher_hash) as searchers,
             count(distinct q.tenant_id) as tenants, max(q.created_at) as last_searched_at
      from public.search_queries q
      where q.result_count = 0 and q.created_at >= ${since.toISOString()}::timestamptz
      group by q.q_normalized
      order by searchers desc, searches desc, q.q_normalized
      limit ${limit}`);
    return z
      .array(
        z.object({
          q_normalized: z.string(),
          searches: z.coerce.number().int(),
          searchers: z.coerce.number().int(),
          tenants: z.coerce.number().int(),
          last_searched_at: z.coerce.date(),
        }),
      )
      .parse([...rows]);
  }

  /** is_open_at() for each id, now (open_states, 0044). */
  async openStates(
    tx: DatabaseTransaction,
    entity: 'store' | 'place',
    ids: readonly string[],
  ): Promise<Map<string, OpenState | null>> {
    const rows = await tx.execute(sql`
      select id, state, changes_at from public.open_states(${entity}, array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[], now())`);
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          state: z.string().nullable(),
          changes_at: z.coerce.date().nullable(),
        }),
      )
      .parse([...rows]);
    return new Map(parsed.map((r) => [r.id, toOpenState(r.state, r.changes_at)]));
  }

  /** Open stores/places near a point (open_ids_near, 0044): the engine's open_now filter. */
  async openIdsNear(
    tx: DatabaseTransaction,
    entity: 'store' | 'place',
    origin: { lat: number; lng: number },
    radiusKm: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await tx.execute(sql`
      select id from public.open_ids_near(${entity}, ${origin.lat}::double precision,
        ${origin.lng}::double precision, ${radiusKm * METRES_PER_KM}::double precision, now(), ${limit}::integer)`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  async fallback(
    tx: DatabaseTransaction,
    type: SearchType,
    query: FallbackQuery,
  ): Promise<FallbackRow[]> {
    const rows = await tx.execute(this.fallbackSql(type, query));
    return z.array(fallbackRow).parse([...rows]);
  }

  private fallbackSql(type: SearchType, q: FallbackQuery): SQL {
    const origin = q.origin;
    const radius = origin && q.radiusKm !== null ? q.radiusKm * METRES_PER_KM : null;
    const categoryFilter = (column: SQL) =>
      q.categoryIds === null
        ? sql`true`
        : sql`${column} in (${sql.join(
            q.categoryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
    const geoFilter = (location: SQL) =>
      origin && radius !== null
        ? sql`st_dwithin(${location}, ${point(origin)}, ${radius})`
        : sql`true`;
    const distance = (location: SQL) =>
      origin ? sql`st_distance(${location}, ${point(origin)})` : sql`null::float8`;
    const order = (location: SQL, recency: SQL) =>
      q.nearestFirst && origin
        ? sql`order by ${distance(location)} asc nulls last, ${recency} desc nulls last`
        : sql`order by ${recency} desc nulls last`;

    switch (type) {
      case 'posts': {
        // Unaliased: postFieldFilterConditions() renders "posts"."<column>".
        const location = sql`posts.location`;
        const fieldConditions = postFieldFilterConditions(q.fieldFilters);
        const priceConditions: SQL[] = [];
        if (q.price?.min != null) {
          priceConditions.push(sql`posts.price * 100 >= ${q.price.min.toString()}::bigint`);
        }
        if (q.price?.max != null) {
          priceConditions.push(sql`posts.price * 100 < ${q.price.max.toString()}::bigint`);
        }
        return sql`
          select posts.id, posts.tenant_id,
            case when posts.title ~ ${BENGALI_PATTERN} then posts.title end as name_bn,
            case when posts.title !~ ${BENGALI_PATTERN} then posts.title end as name_en,
            posts.description, posts.category_id,
            c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
            st_y(${location}::geometry) as lat, st_x(${location}::geometry) as lng,
            ${distance(location)} as distance_m,
            coalesce(posts.bumped_at, posts.published_at, posts.created_at) as published_at,
            posts.price::text as price, null::text as slug
          from public.posts
          join public.categories c on c.id = posts.category_id
          where posts.status_code = 'live'
            and posts.deleted_at is null and posts.scrubbed_at is null and not posts.hidden_by_owner
            and (${!q.shippableOnly}::boolean or c.is_shippable)
            and (posts.expires_at is null or posts.expires_at > now())
            and ${anyTermMatches([sql`posts.title`, sql`posts.description`], q.terms)}
            and ${categoryFilter(sql`posts.category_id`)}
            and ${geoFilter(location)}
            ${fieldConditions.length > 0 ? sql`and ${sql.join(fieldConditions, sql` and `)}` : sql``}
            ${priceConditions.length > 0 ? sql`and ${sql.join(priceConditions, sql` and `)}` : sql``}
            ${q.localityId ? sql`and posts.locality_id = ${q.localityId}::uuid` : sql``}
          ${order(location, sql`coalesce(posts.bumped_at, posts.published_at, posts.created_at)`)}
          limit ${q.limit} offset ${q.offset}`;
      }
      case 'stores': {
        const location = sql`coalesce(st.location, pl.location)`;
        return sql`
          select st.id, st.tenant_id, st.name_bn, st.name_en, st.description, pl.category_id,
            c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
            st_y(${location}::geometry) as lat, st_x(${location}::geometry) as lng,
            ${distance(location)} as distance_m,
            st.created_at as published_at, null::text as price, st.slug
          from public.stores st
          left join public.places pl on pl.tenant_id = st.tenant_id and pl.id = st.place_id
          left join public.categories c on c.id = pl.category_id
          where st.status_code = 'active' and st.deleted_at is null
            and ${anyTermMatches([sql`st.name_bn`, sql`st.name_en`, sql`st.description`], q.terms)}
            and ${categoryFilter(sql`pl.category_id`)}
            and ${geoFilter(location)}
            and ${openFilter(q.openOnly, sql`'store'`, sql`st.id`)}
          ${order(location, sql`st.created_at`)}
          limit ${q.limit} offset ${q.offset}`;
      }
      case 'places': {
        const location = sql`pl.location`;
        return sql`
          select pl.id, pl.tenant_id, pl.name_bn, pl.name_en, pl.description, pl.category_id,
            c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
            st_y(${location}::geometry) as lat, st_x(${location}::geometry) as lng,
            ${distance(location)} as distance_m,
            pl.created_at as published_at, null::text as price, pl.slug
          from public.places pl
          join public.categories c on c.id = pl.category_id
          where pl.status_code in ('published', 'temporarily_closed') and pl.deleted_at is null
            and ${anyTermMatches([sql`pl.name_bn`, sql`pl.name_en`, sql`pl.description`], q.terms)}
            and ${categoryFilter(sql`pl.category_id`)}
            and ${geoFilter(location)}
            and ${openFilter(q.openOnly, sql`'place'`, sql`pl.id`)}
          ${order(location, sql`pl.created_at`)}
          limit ${q.limit} offset ${q.offset}`;
      }
    }
  }
}

/** is_open_at() as a filter (the one implementation, ADR 049); `true` when not filtering. */
function openFilter(openOnly: boolean, entity: SQL, id: SQL): SQL {
  return openOnly
    ? sql`(public.is_open_at(${entity}, ${id}, now())).state in ('open', 'closes_soon')`
    : sql`true`;
}

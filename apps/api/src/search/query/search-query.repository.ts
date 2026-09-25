import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  parseFieldSchema,
  parseUiSchema,
  type CategoryFieldDefinition,
} from '../../categories/field-schema';
import { postFieldFilterConditions } from '../../categories/post-field-filters';
import type { FieldFilter } from '../../categories/field-schema';
import type { DatabaseTransaction } from '../../database/database.client';
import type { SearchType } from '../search.types';
import type { GeoScope } from './filter-builder';

/**
 * Reads for the search API, in the request's own tenant context: RLS
 * applies exactly as for any other request. That is why the Postgres
 * fallback only ever covers the current tenant (no cross-tenant radius
 * discovery without Meilisearch) — the policies decide, not this code.
 */

export interface ResolvedCategory {
  id: string;
  /** The category and every active descendant: searching "rental" includes its children. */
  ids: string[];
  /** Current published field definition, when the category has custom fields. */
  definition: CategoryFieldDefinition | null;
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

function point(geo: GeoScope): SQL {
  return sql`st_setsrid(st_makepoint(${geo.lng}, ${geo.lat}), 4326)::geography`;
}

export interface FallbackQuery {
  terms: readonly string[];
  categoryIds: readonly string[] | null;
  fieldFilters: readonly FieldFilter[];
  geo: GeoScope | null;
  nearestFirst: boolean;
  limit: number;
  offset: number;
}

@Injectable()
export class SearchQueryRepository {
  async resolveCategory(
    tx: DatabaseTransaction,
    slug: string,
  ): Promise<ResolvedCategory | undefined> {
    const rows = await tx.execute(sql`
      with recursive tree as (
        select c.id, 0 as depth from public.categories c
        where c.slug = ${slug} and c.deleted_at is null and c.is_active
        union all
        select c.id, t.depth + 1 from public.categories c
        join tree t on c.parent_id = t.id
        where c.deleted_at is null and c.is_active
      )
      select t.id, t.depth,
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
    return { id: root.id, ids: parsed.map((r) => r.id), definition };
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

  async fallback(
    tx: DatabaseTransaction,
    type: SearchType,
    query: FallbackQuery,
  ): Promise<FallbackRow[]> {
    const rows = await tx.execute(this.fallbackSql(type, query));
    return z.array(fallbackRow).parse([...rows]);
  }

  private fallbackSql(type: SearchType, q: FallbackQuery): SQL {
    const radius = q.geo ? q.geo.radiusKm * METRES_PER_KM : null;
    const categoryFilter = (column: SQL) =>
      q.categoryIds === null
        ? sql`true`
        : sql`${column} in (${sql.join(
            q.categoryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
    const geoFilter = (location: SQL) =>
      q.geo ? sql`st_dwithin(${location}, ${point(q.geo)}, ${radius})` : sql`true`;
    const distance = (location: SQL) =>
      q.geo ? sql`st_distance(${location}, ${point(q.geo)})` : sql`null::float8`;
    const order = (location: SQL, recency: SQL) =>
      q.nearestFirst && q.geo
        ? sql`order by ${distance(location)} asc nulls last, ${recency} desc nulls last`
        : sql`order by ${recency} desc nulls last`;

    switch (type) {
      case 'posts': {
        // Unaliased: postFieldFilterConditions() renders "posts"."<column>".
        const location = sql`posts.location`;
        const fieldConditions = postFieldFilterConditions(q.fieldFilters);
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
            and posts.deleted_at is null and not posts.hidden_by_owner
            and (posts.expires_at is null or posts.expires_at > now())
            and ${anyTermMatches([sql`posts.title`, sql`posts.description`], q.terms)}
            and ${categoryFilter(sql`posts.category_id`)}
            and ${geoFilter(location)}
            ${fieldConditions.length > 0 ? sql`and ${sql.join(fieldConditions, sql` and `)}` : sql``}
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
          ${order(location, sql`pl.created_at`)}
          limit ${q.limit} offset ${q.offset}`;
      }
    }
  }
}

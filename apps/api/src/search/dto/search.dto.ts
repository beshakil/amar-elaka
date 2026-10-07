import { z } from 'zod';
import { openStateSchema } from '../../hours/open-state';
import { createZodDto } from '../../common/pipes/zod-dto';
import { RANGE_OPERATORS, toPoisha, type RawFieldFilter } from '../../categories/field-schema';
import { LEGACY_SORTS, SEARCH_SORTS } from '../query/filter-builder';
import { SEARCH_TYPES } from '../search.types';

// settings-exempt: generic input-length caps, not business thresholds.
const QUERY_MAX_CHARS = 200;
// settings-exempt: generic input-length caps, not business thresholds.
const FILTERS_MAX_CHARS = 2_000;
// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: generic input-length cap on an opaque token, not a business threshold.
const CURSOR_MAX_CHARS = 200;
// settings-exempt: the largest numeric(12,2) amount, a column type
const MONEY_MAX_DIGITS = 10;
// settings-exempt: the scale of numeric(12,2), a column type
const MONEY_DECIMALS = 2;

const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const FILTER_OPERATORS = [...RANGE_OPERATORS, 'in', 'any'] as const;
const filterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

/**
 * `filters` is URL-encoded JSON keyed by field, then operator:
 *   {"bedrooms":{"gte":2},"price":{"lt":"15000"},"property_type":{"in":["flat","house"]}}
 * Checked against the category's schema afterwards (parseFieldFilters), so it
 * needs `category`.
 */
export const fieldFiltersObject = z.record(
  z.string().regex(FIELD_NAME),
  z.record(z.enum(FILTER_OPERATORS), filterValue),
);
/** `{field: {op: value}}` as stored (a saved search's filters.fields). */
export type FieldFiltersObject = z.infer<typeof fieldFiltersObject>;

/** The object form → raw filters, checked against the schema later by parseFieldFilters. */
export function toRawFieldFilters(filters: FieldFiltersObject): RawFieldFilter[] {
  return Object.entries(filters).flatMap(([field, ops]) =>
    Object.entries(ops).map(([op, value]) => ({
      field,
      op,
      value: Array.isArray(value) ? value.join(',') : String(value),
    })),
  );
}

export const filtersParam = z
  .string()
  .max(FILTERS_MAX_CHARS)
  .transform((text, ctx): RawFieldFilter[] => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filters must be JSON' });
      return z.NEVER;
    }
    const parsed = fieldFiltersObject.safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filters must map field → { operator: value }',
      });
      return z.NEVER;
    }
    return toRawFieldFilters(parsed.data);
  });

const coordinate = (max: number) => z.coerce.number().min(-max).max(max);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** "5000", "5000.5" or "5000.50" → "5000.50": money as a string, never a float. */
export const moneyParam = z
  .string()
  .regex(new RegExp(`^\\d{1,${MONEY_MAX_DIGITS}}(\\.\\d{1,2})?$`), 'a price in taka, e.g. 5000.00')
  .transform((v) => {
    const [whole, fraction = ''] = v.split('.');
    return `${whole}.${fraction.padEnd(MONEY_DECIMALS, '0')}`;
  });

const locationShape = {
  lat: coordinate(MAX_LAT).optional(),
  lng: coordinate(MAX_LNG).optional(),
};
const bothOrNeither = (v: { lat?: number | undefined; lng?: number | undefined }) =>
  (v.lat === undefined) === (v.lng === undefined);

/** Same scopes as GET /feed (ADR 035). */
export const SEARCH_SCOPES = ['area', 'nearby', 'country'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

const sortParam = z.preprocess(
  (v) =>
    typeof v === 'string' && Object.hasOwn(LEGACY_SORTS, v)
      ? LEGACY_SORTS[v as keyof typeof LEGACY_SORTS]
      : v,
  z.enum(SEARCH_SORTS),
);

/**
 * GET /search. Discovery is a radius around the viewer (schema.md §13.26),
 * with the feed's scopes:
 *   area    — search_default_radius_km (tenant setting); radius_km is ignored.
 *   nearby  — radius_km, capped at search_max_radius_km.
 *   country — shippable categories only, no radius.
 * Without lat/lng the tenant's map centre stands in for the viewer.
 * Paging: `cursor` (from the previous page's nextCursor); `page` is kept for
 * older clients.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(QUERY_MAX_CHARS).default(''),
    type: z.enum(SEARCH_TYPES).default('posts'),
    scope: z.enum(SEARCH_SCOPES).default('area'),
    category: slug.optional(),
    /**
     * One area of this tenant, by its URL slug (a category + area landing
     * page, ADR 042): results in that area, around its centre.
     */
    area: slug.optional(),
    ...locationShape,
    /** Kilometres, scope=nearby only; capped at search_max_radius_km. */
    radius_km: z.coerce.number().positive().optional(),
    filters: filtersParam.optional(),
    /** Posts: price in taka, inclusive lower bound (a price facet bucket's `min`). */
    price_min: moneyParam.optional(),
    /** Posts: price in taka, exclusive upper bound (a price facet bucket's `max`). */
    price_max: moneyParam.optional(),
    /** relevance | newest | price_asc | price_desc | distance (| rating for stores/places). */
    sort: sortParam.default('relevance'),
    cursor: z
      .string()
      .max(CURSOR_MAX_CHARS)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    /** @deprecated use `cursor`. */
    page: z.coerce.number().int().min(1).optional(),
    /** Defaults to search_page_size_default, capped at search_page_size_max. */
    limit: z.coerce.number().int().min(1).optional(),
    /** Stores/places open now (is_open_at, ADR 049). Posts have no opening hours. */
    open_now: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .refine(bothOrNeither, { message: 'lat and lng go together', path: ['lat'] })
  .refine((v) => !v.open_now || v.type !== 'posts', {
    message: 'open_now applies to stores and places, which have opening hours',
    path: ['open_now'],
  })
  .refine((v) => v.sort !== 'distance' || v.lat !== undefined, {
    message: 'sort=distance needs lat and lng',
    path: ['sort'],
  })
  .refine((v) => v.filters === undefined || v.category !== undefined, {
    message: 'filters need a category',
    path: ['filters'],
  })
  .refine((v) => v.cursor === undefined || v.page === undefined, {
    message: 'use cursor or page, not both',
    path: ['cursor'],
  })
  .refine(
    (v) =>
      v.price_min === undefined ||
      v.price_max === undefined ||
      toPoisha(v.price_min) < toPoisha(v.price_max),
    { message: 'price_min must be below price_max', path: ['price_min'] },
  );
export class SearchQueryDto extends createZodDto(searchQuerySchema) {}
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const suggestQuerySchema = z
  .object({
    q: z.string().trim().max(QUERY_MAX_CHARS).default(''),
    ...locationShape,
  })
  .refine(bothOrNeither, { message: 'lat and lng go together', path: ['lat'] });
export class SuggestQueryDto extends createZodDto(suggestQuerySchema) {}
export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

/** POST /search/click: the searcher opened one of the results. */
export const searchClickSchema = z.object({
  /** `searchId` of the search response. */
  searchId: z.string().uuid(),
  postId: z.string().uuid(),
});
export class SearchClickDto extends createZodDto(searchClickSchema) {}
export type SearchClick = z.infer<typeof searchClickSchema>;

// ---- responses ----------------------------------------------------------

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });

export const searchHitSchema = z.object({
  id: z.string(),
  type: z.enum(SEARCH_TYPES),
  tenantId: z.string(),
  name: localized,
  /** Banglish spelling, e.g. for a Latin-keyboard UI. */
  nameTranslit: z.string(),
  description: z.string().nullable(),
  category: z.object({ id: z.string(), slug: z.string(), name: localized }).nullable(),
  area: localized.nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  /** Metres from the request's lat/lng, when one was sent. */
  distanceMeters: z.number().nullable(),
  /** Boosted within the category's slot cap (the feed's rule). */
  isBoosted: z.boolean(),
  publishedAt: z.string(),
  /** Money as a string with two decimals, never a float (posts only). */
  price: z.string().nullable(),
  /** The category's list-card fields, as stored. */
  cardFields: z.record(z.unknown()),
  rating: z.number().nullable(),
  slug: z.string().nullable(),
  cover: z.object({ thumbUrl: z.string(), thumbhash: z.string().nullable() }).nullable(),
  isVerified: z.boolean(),
  isLandmark: z.boolean(),
  /** Stores/places: is_open_at() now (ADR 049); null for posts. */
  openState: openStateSchema.nullable(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

const facetValue = z.object({ value: z.string(), count: z.number().int() });
const fieldFacet = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('values'), values: z.array(facetValue) }),
  /** Numeric fields: bounds of the current results (money as strings). */
  z.object({
    kind: z.literal('range'),
    min: z.union([z.number(), z.string()]),
    max: z.union([z.number(), z.string()]),
  }),
]);

/** Money strings; pass a bucket's min/max back as price_min/price_max. */
export const priceFacetSchema = z.object({
  min: z.string(),
  max: z.string(),
  buckets: z.array(
    z.object({
      min: z.string(),
      /** Exclusive; null on the last, open-ended bucket. */
      max: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
});
export type PriceFacet = z.infer<typeof priceFacetSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  /**
   * Id of this search in the query log (first page of a text search), for
   * POST /search/click; null when nothing was logged.
   */
  searchId: z.string().nullable(),
  hits: z.array(searchHitSchema),
  /**
   * First page of a text search (no category): matching landmarks within
   * the radius, shown above the results. Empty otherwise.
   */
  landmarks: z.array(searchHitSchema),
  /** Pass back as `cursor` with the same parameters; null at the end. */
  nextCursor: z.string().nullable(),
  /** @deprecated 1-based page number, for clients still paging by `page`. */
  page: z.number().int(),
  limit: z.number().int(),
  /** Estimated by Meilisearch; exact enough for "about N results". */
  totalHits: z.number().int(),
  scope: z.enum(SEARCH_SCOPES),
  /** The radius actually used; null for the country scope. */
  radiusKm: z.number().nullable(),
  /** The area searched (`area`), with its names; null otherwise. */
  area: z
    .object({ slug: z.string(), name: z.object({ bn: z.string(), en: z.string().nullable() }) })
    .nullable(),
  facets: z.object({
    categories: z.array(z.object({ slug: z.string(), count: z.number().int() })),
    /** Posts with a price in the results (ignoring the price filter itself). */
    price: priceFacetSchema.nullable(),
    /** The chosen category's top select-type fields (and its numeric ranges). */
    fields: z.record(fieldFacet),
  }),
  /**
   * True when Meilisearch was unreachable and Postgres answered instead:
   * this tenant only, simpler matching, no facets.
   */
  degraded: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export class SearchResponseDto extends createZodDto(searchResponseSchema) {}

export const suggestResponseSchema = z.object({
  query: z.string(),
  categories: z.array(z.object({ slug: z.string(), name: localized })),
  /** Popular searches in this tenant that start like the input (normalized form). */
  queries: z.array(z.object({ query: z.string() })),
  /** Top matching listing titles near the viewer. */
  listings: z.array(
    z.object({
      id: z.string(),
      tenantId: z.string(),
      title: localized,
      categorySlug: z.string().nullable(),
    }),
  ),
  /** True when the listings could not be searched (engine down). */
  degraded: z.boolean(),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;
export class SuggestResponseDto extends createZodDto(suggestResponseSchema) {}

export const trendingResponseSchema = z.object({
  windowHours: z.number().int(),
  queries: z.array(
    z.object({
      query: z.string(),
      /** Distinct people who searched it in the window. */
      searchers: z.number().int(),
    }),
  ),
});
export type TrendingResponse = z.infer<typeof trendingResponseSchema>;
export class TrendingResponseDto extends createZodDto(trendingResponseSchema) {}

export const searchClickResultSchema = z.object({ recorded: z.boolean() });
export type SearchClickResult = z.infer<typeof searchClickResultSchema>;
export class SearchClickResultDto extends createZodDto(searchClickResultSchema) {}

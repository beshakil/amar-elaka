import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { RANGE_OPERATORS, type RawFieldFilter } from '../../categories/field-schema';
import { SEARCH_SORTS } from '../query/filter-builder';
import { SEARCH_TYPES } from '../search.types';

// settings-exempt: generic input-length caps, not business thresholds.
const QUERY_MAX_CHARS = 200;
// settings-exempt: generic input-length caps, not business thresholds.
const FILTERS_MAX_CHARS = 2_000;
// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;

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
const filtersParam = z
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
    const parsed = z
      .record(z.string().regex(FIELD_NAME), z.record(z.enum(FILTER_OPERATORS), filterValue))
      .safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filters must map field → { operator: value }',
      });
      return z.NEVER;
    }
    return Object.entries(parsed.data).flatMap(([field, ops]) =>
      Object.entries(ops).map(([op, value]) => ({
        field,
        op,
        value: Array.isArray(value) ? value.join(',') : String(value),
      })),
    );
  });

const coordinate = (max: number) => z.coerce.number().min(-max).max(max);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const locationShape = {
  lat: coordinate(MAX_LAT).optional(),
  lng: coordinate(MAX_LNG).optional(),
};
const bothOrNeither = (v: { lat?: number | undefined; lng?: number | undefined }) =>
  (v.lat === undefined) === (v.lng === undefined);

export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(QUERY_MAX_CHARS).default(''),
    type: z.enum(SEARCH_TYPES).default('posts'),
    category: slug.optional(),
    ...locationShape,
    /** Kilometres; defaults to search_default_radius_km, capped at search_max_radius_km. */
    radius: z.coerce.number().positive().optional(),
    filters: filtersParam.optional(),
    sort: z.enum(SEARCH_SORTS).default('relevance'),
    page: z.coerce.number().int().min(1).default(1),
    /** Defaults to search_page_size_default, capped at search_page_size_max. */
    limit: z.coerce.number().int().min(1).optional(),
  })
  .refine(bothOrNeither, { message: 'lat and lng go together', path: ['lat'] })
  .refine((v) => v.sort !== 'nearest' || v.lat !== undefined, {
    message: 'sort=nearest needs lat and lng',
    path: ['sort'],
  })
  .refine((v) => v.filters === undefined || v.category !== undefined, {
    message: 'filters need a category',
    path: ['filters'],
  });
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

export const searchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
  page: z.number().int(),
  limit: z.number().int(),
  /** Estimated by Meilisearch; exact enough for "about N results". */
  totalHits: z.number().int(),
  facets: z.object({
    categories: z.array(z.object({ slug: z.string(), count: z.number().int() })),
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

export const suggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('category'), slug: z.string(), name: localized }),
  z.object({
    kind: z.enum(SEARCH_TYPES),
    id: z.string(),
    name: localized,
    categorySlug: z.string().nullable(),
    slug: z.string().nullable(),
  }),
]);
export type Suggestion = z.infer<typeof suggestionSchema>;

export const suggestResponseSchema = z.object({
  query: z.string(),
  suggestions: z.array(suggestionSchema),
  degraded: z.boolean(),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;
export class SuggestResponseDto extends createZodDto(suggestResponseSchema) {}

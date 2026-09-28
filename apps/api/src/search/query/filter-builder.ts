import { toPoisha, type FieldFilter } from '../../categories/field-schema';

/**
 * Search request → Meilisearch filter expressions. Pure. Every string value
 * is quoted and escaped; field names come from a published schema (checked
 * by parseFieldFilters) and are never taken from the request as-is.
 */

// settings-exempt: km → metres, a unit conversion
const METRES_PER_KM = 1_000;

export interface GeoScope {
  lat: number;
  lng: number;
  radiusKm: number;
}

/** Double-quoted Meilisearch filter literal. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function list(values: readonly string[]): string {
  return `[${values.map(quote).join(', ')}]`;
}

const OPERATORS = { eq: '=', gte: '>=', lte: '<=', gt: '>', lt: '<' } as const;

function yyyymmdd(date: string): number {
  return Number(date.replace(/-/g, ''));
}

export function fieldFilterExpression(filter: FieldFilter): string {
  const attribute = `fields.${filter.field}`;
  switch (filter.kind) {
    case 'number':
      return `${attribute} ${OPERATORS[filter.op]} ${filter.value}`;
    case 'money':
      return `${attribute} ${OPERATORS[filter.op]} ${toPoisha(filter.value).toString()}`;
    case 'date':
      return `${attribute} ${OPERATORS[filter.op]} ${yyyymmdd(filter.value)}`;
    case 'equals':
      return typeof filter.value === 'boolean'
        ? `${attribute} = ${filter.value}`
        : `${attribute} = ${quote(filter.value)}`;
    case 'one_of':
      // On a multiselect (an array attribute) IN matches when any element is in the list.
      return `${attribute} IN ${list(filter.values)}`;
  }
}

/** Only these documents (an explicit sort of a text search, search.service.ts). */
export function idsIn(ids: readonly string[]): string {
  return `id IN ${list(ids)}`;
}

/** Price bounds in poisha: `min` inclusive, `max` exclusive (a bucket's own convention). */
export interface PriceRange {
  min: bigint | null;
  max: bigint | null;
}

export function priceExpressions(range: PriceRange | null): string[] {
  if (range === null) return [];
  const out: string[] = [];
  if (range.min !== null) out.push(`price_minor >= ${range.min.toString()}`);
  if (range.max !== null) out.push(`price_minor < ${range.max.toString()}`);
  return out;
}

/**
 * The boundary rule of §13.26: discovery is always pure radius and crosses
 * tenants — boundaries decide ownership, never visibility. There is no
 * tenant-only filter; without the viewer's location the caller searches
 * around the tenant's map centre instead. The one exception is the feed's
 * `country` scope: no radius, shippable categories only (`geo` null).
 */
export function buildSearchFilter(input: {
  geo: GeoScope | null;
  shippableOnly?: boolean;
  /** One area of a tenant (a landing page, ADR 042), on top of the radius. */
  localityId?: string | null;
  categoryIds: readonly string[] | null;
  fieldFilters: readonly FieldFilter[];
  price?: PriceRange | null;
}): string[] {
  const filters: string[] = [];
  if (input.geo !== null) {
    const metres = Math.round(input.geo.radiusKm * METRES_PER_KM);
    filters.push(`_geoRadius(${input.geo.lat}, ${input.geo.lng}, ${metres})`);
  }
  if (input.shippableOnly) filters.push('is_shippable = true');
  if (input.localityId) filters.push(`locality_id = ${quote(input.localityId)}`);
  if (input.categoryIds !== null) filters.push(`category_id IN ${list(input.categoryIds)}`);
  for (const filter of input.fieldFilters) filters.push(fieldFilterExpression(filter));
  filters.push(...priceExpressions(input.price ?? null));
  return filters;
}

export const SEARCH_SORTS = [
  'relevance',
  'newest',
  'price_asc',
  'price_desc',
  'distance',
  // Stores and places.
  'rating',
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
/** Accepted for older clients; means `distance`. */
export const LEGACY_SORTS = { nearest: 'distance' } as const satisfies Record<string, SearchSort>;

/**
 * The request's sort, applied at the `sort` step of the ranking rules (after
 * text relevance and boosts). With a location, "relevance" still sorts by
 * distance there — that is the "nearby" step — and it returns `_geoDistance`.
 * `geo` is where distance is measured from: in the country scope that is
 * the viewer (or the tenant's centre) without a radius.
 */
export function buildSort(sort: SearchSort, geo: Pick<GeoScope, 'lat' | 'lng'> | null): string[] {
  const nearest = geo ? [`_geoPoint(${geo.lat}, ${geo.lng}):asc`] : [];
  switch (sort) {
    case 'relevance':
    case 'distance':
      return nearest;
    case 'newest':
      return ['published_at:desc', ...nearest];
    case 'price_asc':
      return ['price_minor:asc', ...nearest];
    case 'price_desc':
      return ['price_minor:desc', ...nearest];
    case 'rating':
      return ['rating_avg:desc', ...nearest];
  }
}

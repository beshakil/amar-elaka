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

/**
 * The boundary rule of §13.26: with a location, discovery is pure radius and
 * crosses tenants; without one, results stay in the request's tenant.
 */
export function buildSearchFilter(input: {
  tenantId: string;
  geo: GeoScope | null;
  categoryIds: readonly string[] | null;
  fieldFilters: readonly FieldFilter[];
}): string[] {
  const filters: string[] = [];
  if (input.geo) {
    const metres = Math.round(input.geo.radiusKm * METRES_PER_KM);
    filters.push(`_geoRadius(${input.geo.lat}, ${input.geo.lng}, ${metres})`);
  } else {
    filters.push(`tenant_id = ${quote(input.tenantId)}`);
  }
  if (input.categoryIds !== null) filters.push(`category_id IN ${list(input.categoryIds)}`);
  for (const filter of input.fieldFilters) filters.push(fieldFilterExpression(filter));
  return filters;
}

export const SEARCH_SORTS = [
  'relevance',
  'newest',
  'nearest',
  'price_asc',
  'price_desc',
  'rating',
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/**
 * The request's sort, applied at the `sort` step of the ranking rules (after
 * text relevance and boosts). With a location, "relevance" still sorts by
 * distance there — that is the "nearby" step — and it returns `_geoDistance`.
 */
export function buildSort(sort: SearchSort, geo: GeoScope | null): string[] {
  const nearest = geo ? [`_geoPoint(${geo.lat}, ${geo.lng}):asc`] : [];
  switch (sort) {
    case 'relevance':
    case 'nearest':
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

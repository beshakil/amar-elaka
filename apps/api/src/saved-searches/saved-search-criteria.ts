import { z } from 'zod';
import {
  fieldFiltersObject,
  toRawFieldFilters,
  type FieldFiltersObject,
} from '../search/dto/search.dto';
import type { CriteriaInput } from '../search/query/search-criteria.service';

/** A saved_searches row as both the API and the matcher read it. */
export const storedSavedSearch = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  query_text: z.string().nullable(),
  category_id: z.string().nullable(),
  category_slug: z.string().nullable(),
  filters: z.object({ fields: fieldFiltersObject.optional() }).passthrough(),
  price_min: z.string().nullable(),
  price_max: z.string().nullable(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radius_km: z.coerce.number(),
  alert_frequency_code: z.enum(['instant', 'daily', 'off']),
  is_active: z.boolean(),
  paused_at: z.coerce.date().nullable(),
  last_alerted_at: z.coerce.date().nullable(),
  last_engaged_at: z.coerce.date().nullable(),
  notify_day: z.string().nullable(),
  notify_count: z.coerce.number().int(),
  created_at: z.coerce.date(),
});
export type StoredSavedSearch = z.infer<typeof storedSavedSearch>;

/** The stored field filters, `{}` when there are none. */
export function storedFields(search: Pick<StoredSavedSearch, 'filters'>): FieldFiltersObject {
  return search.filters.fields ?? {};
}

/**
 * A saved search, as SearchCriteriaService input: a nearby search around its
 * centre with its own radius, text, category, field filters and price range.
 * The only translation between a saved search and a search — everything
 * after this (category tree, schema check, filters, matching) is the shared
 * search code (ADR 041).
 */
export function savedSearchCriteriaInput(
  search: Pick<
    StoredSavedSearch,
    | 'query_text'
    | 'category_id'
    | 'filters'
    | 'price_min'
    | 'price_max'
    | 'lat'
    | 'lng'
    | 'radius_km'
  >,
  tenantId: string,
): CriteriaInput {
  const fields = storedFields(search);
  return {
    tenantId,
    type: 'posts',
    q: search.query_text ?? '',
    scope: 'nearby',
    origin: { lat: search.lat, lng: search.lng },
    radiusKm: search.radius_km,
    category: search.category_id === null ? null : { id: search.category_id },
    filters: Object.keys(fields).length > 0 ? toRawFieldFilters(fields) : undefined,
    priceMin: search.price_min ?? undefined,
    priceMax: search.price_max ?? undefined,
  };
}

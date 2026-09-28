import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { z } from 'zod';
import type { TenantConfig } from '../api/schemas';
import { filtersJson } from './load';
import { parseSearchParams, type Query } from './params';

/** Where a save may send the visitor back to: this site's own search, nothing else. */
export function safeSearchReturn(value: unknown): string {
  return typeof value === 'string' && /^\/search(\?[^#]*)?$/.test(value) ? value : '/search';
}

/** A return path's query as the parser reads it (repeated parameters kept). */
export function queryOf(path: string): Query {
  const params = new URL(path, 'http://local').searchParams;
  const query: Query = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

const formSchema = z.object({
  name: z.string().trim().min(1).max(80),
  frequency: z.enum(['instant', 'daily', 'off']),
  radius_km: z.coerce.number().min(0.5).optional(),
});

/**
 * POST /saved-searches' body for the search at [returnPath] (ADR 041): the
 * same text, category, field filters and price range the page showed,
 * around the area's centre (the web has no visitor location) with the radius
 * the results used. Null when the form itself is invalid.
 */
export function savedSearchBody(
  form: FormData,
  returnPath: string,
  tenant: TenantConfig,
  schema: CategoryFieldSchema | null,
) {
  const parsed = formSchema.safeParse({
    name: form.get('name'),
    frequency: form.get('frequency') ?? 'daily',
    radius_km: form.get('radius_km') ?? undefined,
  });
  const radiusKm = parsed.success ? (parsed.data.radius_km ?? tenant.radiusKm) : null;
  if (!parsed.success || radiusKm === null) return null;
  const params = parseSearchParams(queryOf(returnPath));
  const fields = filtersJson(params, schema);
  return {
    name: parsed.data.name,
    q: params.q,
    filters: {
      ...(params.category ? { category: params.category } : {}),
      ...(fields ? { fields: JSON.parse(fields) as Record<string, Record<string, string>> } : {}),
      ...(params.priceMin ? { price_min: params.priceMin } : {}),
      ...(params.priceMax ? { price_max: params.priceMax } : {}),
    },
    center: tenant.mapCenter,
    radius_km: radiusKm,
    frequency: parsed.data.frequency,
  };
}

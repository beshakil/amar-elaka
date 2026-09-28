import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { apiFetch } from '../api/fetch';
import { categoryAreasSchema, searchResponseSchema, type TenantConfig } from '../api/schemas';
import { filtersFromQuery } from '../listings/filters';
import { INSTALL_COOKIE } from '../listings/visitor';
import { filterQuery, type SearchParams } from './params';

/**
 * The search pages' reads (ADR 042).
 *
 *  - /search runs uncached, with the visitor's browser id and address: the
 *    API logs a text search for trending (counted in distinct searchers),
 *    and this server making the call must not make every visitor one.
 *  - The category + area landing pages and their list are anonymous and
 *    cached like the category page (the tenant's category window).
 */

/** The visitor, as the API's query log should see them (never an account). */
async function visitorHeaders(): Promise<Record<string, string>> {
  const [requestHeaders, store] = await Promise.all([headers(), cookies()]);
  const forwarded = requestHeaders.get('x-forwarded-for') ?? requestHeaders.get('x-real-ip');
  const install = store.get(INSTALL_COOKIE)?.value;
  const agent = requestHeaders.get('user-agent');
  return {
    ...(install && /^[A-Za-z0-9_-]{8,64}$/.test(install) ? { 'X-Install-Id': install } : {}),
    ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}),
    ...(agent ? { 'User-Agent': agent } : {}),
  };
}

/** The API's `filters` for the chosen category's `f.*` parameters (null without any). */
export function filtersJson(
  params: SearchParams,
  schema: CategoryFieldSchema | null,
): string | null {
  if (!schema || Object.keys(params.filters).length === 0) return null;
  return filtersFromQuery(schema, filterQuery(params)).json;
}

export async function runSearch(
  tenant: TenantConfig,
  params: SearchParams,
  schema: CategoryFieldSchema | null,
) {
  const filters = filtersJson(params, schema);
  return apiFetch({
    path: '/search',
    schema: searchResponseSchema,
    tenantId: tenant.id,
    headers: await visitorHeaders(),
    query: {
      type: 'posts',
      ...(params.q ? { q: params.q } : {}),
      ...(params.category ? { category: params.category } : {}),
      ...(filters ? { filters } : {}),
      ...(params.priceMin ? { price_min: params.priceMin } : {}),
      ...(params.priceMax ? { price_max: params.priceMax } : {}),
      sort: params.sort,
      page: String(params.page),
    },
  });
}

/** The landing pages that exist: category × area pairs with enough listings. */
export const categoryAreas = cache((tenant: TenantConfig) =>
  apiFetch({
    path: '/seo/category-areas',
    schema: categoryAreasSchema,
    tenantId: tenant.id,
    revalidate: tenant.web?.categoryRevalidateSeconds,
  }),
);

/** A category + area landing page's listings, newest first. */
export const areaListings = cache(
  (tenant: TenantConfig, category: string, area: string, page: number) =>
    apiFetch({
      path: '/search',
      schema: searchResponseSchema,
      tenantId: tenant.id,
      query: { type: 'posts', category, area, sort: 'newest', page: String(page) },
      revalidate: tenant.web?.categoryRevalidateSeconds,
    }),
);

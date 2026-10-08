import { cache } from 'react';
import { ApiError } from '../api/errors';
import { apiFetch } from '../api/fetch';
import {
  bazarCardSchema,
  catalogCategorySchema,
  emergencyCardSchema,
  feedInfoSchema,
  listingStatusSchema,
  postDetailSchema,
  searchResponseSchema,
  storeCatalogSchema,
  storePageSchema,
  type TenantConfig,
} from '../api/schemas';
import { z } from 'zod';

/**
 * The public pages' reads (ADR 039). Every one is anonymous — the same HTML
 * for every visitor — and cached in Next's data cache for the window the
 * tenant config gives (settings). That is this app's ISR: the tenant comes
 * from the Host header, so pages render per request, but a render is a few
 * cached reads.
 */
type Window = keyof NonNullable<TenantConfig['web']>;

const revalidate = (tenant: TenantConfig, window: Window): number | undefined =>
  tenant.web?.[window];

export const listingStatus = cache((tenant: TenantConfig, id: string) =>
  apiFetch({
    path: `/seo/listing-status/${id}`,
    schema: listingStatusSchema,
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
  }),
);

/** The detail as a visitor sees it; null when the API no longer shows it. */
export const listingDetail = cache(async (tenant: TenantConfig, id: string) => {
  try {
    return await apiFetch({
      path: `/posts/${id}/detail`,
      schema: postDetailSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

/** The categories with their field schemas (for the filter form). */
export const catalog = cache((tenant: TenantConfig) =>
  apiFetch({
    path: '/categories',
    schema: z.array(catalogCategorySchema),
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'categoryRevalidateSeconds'),
  }),
);

/** A page of a category's listings, newest first, radius around the area (search). */
export const categoryListings = cache(
  (tenant: TenantConfig, slug: string, page: number, filtersJson: string | null) =>
    apiFetch({
      path: '/search',
      schema: searchResponseSchema,
      tenantId: tenant.id,
      query: {
        type: 'posts',
        category: slug,
        sort: 'newest',
        page: String(page),
        ...(filtersJson ? { filters: filtersJson } : {}),
      },
      revalidate: revalidate(tenant, 'categoryRevalidateSeconds'),
    }),
);

export const recentListings = cache((tenant: TenantConfig) =>
  apiFetch({
    path: '/search',
    schema: searchResponseSchema,
    tenantId: tenant.id,
    query: { type: 'posts', sort: 'newest' },
    revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
  }),
);

/** The feed's info cards: today's bazar prices and the emergency shortcut. */
export const infoCards = cache(async (tenant: TenantConfig) => {
  const page = await apiFetch({
    path: '/feed',
    schema: feedInfoSchema,
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
  });
  const first = <T>(schema: z.ZodType<T>): T | undefined => {
    for (const item of page.items) {
      const parsed = schema.safeParse(item);
      if (parsed.success) return parsed.data;
    }
    return undefined;
  };
  return { bazar: first(bazarCardSchema), emergency: first(emergencyCardSchema) };
});

/** The store's public page; null when there's no such active store here. */
export const storePage = cache(async (tenant: TenantConfig, slug: string) => {
  try {
    return await apiFetch({
      path: `/stores/${slug}`,
      schema: storePageSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

/** The store's WhatsApp catalog (ADR 056); null when there's no such active store here. */
export const storeCatalog = cache(async (tenant: TenantConfig, slug: string) => {
  try {
    return await apiFetch({
      path: `/stores/${slug}/catalog`,
      schema: storeCatalogSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

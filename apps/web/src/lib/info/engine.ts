import { cache } from 'react';
import { ApiError } from '../api/errors';
import { apiFetch } from '../api/fetch';
import {
  govServiceDetailSchema,
  govVersionSchema,
  infoListSchema,
  infoServicesSchema,
  lostFoundDetailSchema,
  noticeDetailSchema,
  prayerSettingsSchema,
  routeDetailSchema,
  type TenantConfig,
} from '../api/schemas';
import { revalidate } from '../listings/load';

/**
 * The info engine's public pages (ADR 065). The web has no visitor position
 * on the server, so lists are around the area's centre (the API's default
 * origin) — still radius-based, never "this area only".
 */
export const infoList = cache(
  async (tenant: TenantConfig, path: string, query: Record<string, string> = {}) =>
    apiFetch({
      path,
      query,
      schema: infoListSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
    }),
);

/** A detail page's item, or null when it is gone (404 → notFound()). */
async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

export const noticeDetail = cache(async (tenant: TenantConfig, id: string) =>
  orNull(() =>
    apiFetch({
      path: `/info/notices/${id}`,
      schema: noticeDetailSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    }),
  ),
);

export const lostFoundDetail = cache(async (tenant: TenantConfig, id: string) =>
  orNull(() =>
    apiFetch({
      path: `/info/lost-found/${id}`,
      schema: lostFoundDetailSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    }),
  ),
);

export const routeDetail = cache(async (tenant: TenantConfig, id: string) =>
  orNull(() =>
    apiFetch({
      path: `/info/transport/routes/${id}`,
      schema: routeDetailSchema,
      tenantId: tenant.id,
      // "Next departures" move with the clock: never long-cached.
      revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
    }),
  ),
);

export const govServiceDetail = cache(async (tenant: TenantConfig, slug: string) =>
  orNull(() =>
    apiFetch({
      path: `/info/gov-services/${slug}`,
      schema: govServiceDetailSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    }),
  ),
);

export const govServiceVersion = cache(async (tenant: TenantConfig, slug: string, no: number) =>
  orNull(() =>
    apiFetch({
      path: `/info/gov-services/${slug}/versions/${no}`,
      schema: govVersionSchema,
      tenantId: tenant.id,
      revalidate: revalidate(tenant, 'listingRevalidateSeconds'),
    }),
  ),
);

export const prayerSettings = cache(async (tenant: TenantConfig) =>
  apiFetch({
    path: '/info/prayer/settings',
    schema: prayerSettingsSchema,
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
  }),
);

export const infoServices = cache(async (tenant: TenantConfig) =>
  apiFetch({
    path: '/info/services',
    schema: infoServicesSchema,
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
  }),
);

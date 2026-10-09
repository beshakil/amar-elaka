import { notFound } from 'next/navigation';
import { cache } from 'react';
import { ApiError } from '../api/errors';
import { apiFetch } from '../api/fetch';
import {
  importListSchema,
  myStoresSchema,
  sellerAnalyticsSchema,
  sellerStoreSchema,
  storeProductsSchema,
  type MyStores,
  type SellerAnalytics,
  type SellerStore,
  type StoreProducts,
} from '../api/schemas';
import type { Viewer } from '../auth/viewer';

/** The seller panel's reads (ADR 057), as the signed-in seller; the API decides who may see what. */

const auth = (viewer: Viewer) => ({
  tenantId: viewer.tenantId,
  accessToken: viewer.session.accessToken,
});

/** The stores the seller runs or has joined (accepted). */
export async function sellerStores(viewer: Viewer): Promise<MyStores['items']> {
  const mine = await apiFetch({ path: '/stores/me', schema: myStoresSchema, ...auth(viewer) });
  return mine.items.filter((store) => store.accepted);
}

/** The store as its people see it; 404 for anyone else (or no such store). */
export const sellerStore = cache(async (viewer: Viewer, storeId: string): Promise<SellerStore> => {
  try {
    return await apiFetch({
      path: `/stores/${storeId}/manage`,
      schema: sellerStoreSchema,
      ...auth(viewer),
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) notFound();
    throw error;
  }
});

export function storeAnalytics(
  viewer: Viewer,
  storeId: string,
  days: number | null,
): Promise<SellerAnalytics> {
  return apiFetch({
    path: `/stores/${storeId}/analytics`,
    schema: sellerAnalyticsSchema,
    ...auth(viewer),
    ...(days ? { query: { period: `${days}d` } } : {}),
  });
}

export function storeProducts(
  viewer: Viewer,
  storeId: string,
  cursor: string | undefined,
): Promise<StoreProducts> {
  return apiFetch({
    path: `/stores/${storeId}/products`,
    schema: storeProductsSchema,
    ...auth(viewer),
    ...(cursor ? { query: { cursor } } : {}),
  });
}

export function recentImports(viewer: Viewer, storeId: string) {
  return apiFetch({
    path: `/stores/${storeId}/imports`,
    schema: importListSchema,
    ...auth(viewer),
  });
}

import { ApiError } from '../api/errors';
import { apiFetch } from '../api/fetch';
import {
  reviewEligibilitySchema,
  reviewPageSchema,
  type ReviewEligibility,
  type ReviewPage,
  type TenantConfig,
} from '../api/schemas';
import type { Viewer } from '../auth/viewer';

/** A store's published reviews (ADR 061), newest first; public, cached like the store page. */
export async function storeReviews(
  tenant: TenantConfig,
  storeId: string,
  before?: string,
): Promise<ReviewPage | null> {
  try {
    return await apiFetch({
      path: `/stores/${storeId}/reviews`,
      schema: reviewPageSchema,
      tenantId: tenant.id,
      ...(before ? { query: { before } } : {}),
      // The store page's own window (a setting, via the tenant config).
      revalidate: tenant.web?.listingRevalidateSeconds,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** May the signed-in viewer review this store — and their own review, uncached. */
export function reviewEligibility(viewer: Viewer, storeId: string): Promise<ReviewEligibility> {
  return apiFetch({
    path: `/stores/${storeId}/reviews/eligibility`,
    schema: reviewEligibilitySchema,
    tenantId: viewer.tenantId,
    accessToken: viewer.session.accessToken,
  });
}

/** The reviews of a store its owner or manager runs, uncached (the seller panel). */
export function sellerReviews(
  viewer: Viewer,
  storeId: string,
  before?: string,
): Promise<ReviewPage> {
  return apiFetch({
    path: `/stores/${storeId}/reviews`,
    schema: reviewPageSchema,
    tenantId: viewer.tenantId,
    accessToken: viewer.session.accessToken,
    ...(before ? { query: { before } } : {}),
  });
}

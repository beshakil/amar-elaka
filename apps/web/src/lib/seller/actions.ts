'use server';

import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import { ApiError, ApiShapeError, ApiUnreachableError } from '../api/errors';
import {
  importViewSchema,
  storeProductsSchema,
  type ImportView,
  type StoreProducts,
} from '../api/schemas';
import { readSession } from '../auth/session';
import { currentTenantId } from '../tenant';

/** The seller panel's actions (ADR 057). Post changes reuse lib/posts/actions. */

export type SellerResult<T> =
  { ok: true; data: T } | { ok: false; code: string; details?: unknown };

const uuid = z.string().uuid();
const startSchema = z
  .object({
    categoryId: z.string().uuid(),
    sheetMediaId: z.string().uuid(),
    imagesMediaId: z.string().uuid().optional(),
    dryRun: z.boolean(),
  })
  .strict();

async function asSeller<T>(
  call: (auth: { tenantId: string; accessToken: string }) => Promise<T>,
): Promise<SellerResult<T>> {
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session) return { ok: false, code: 'UNAUTHENTICATED' };
  if (!tenantId) return { ok: false, code: 'TENANT_REQUIRED' };
  try {
    return { ok: true, data: await call({ tenantId, accessToken: session.accessToken }) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, code: error.code, details: error.details };
    if (error instanceof ApiUnreachableError) return { ok: false, code: 'NETWORK' };
    if (error instanceof ApiShapeError) return { ok: false, code: 'UNEXPECTED_RESPONSE' };
    throw error;
  }
}

/** A page of the product table, after a change (the table refetches what it shows). */
export async function productsPage(
  storeId: string,
  cursor?: string,
): Promise<SellerResult<StoreProducts>> {
  if (
    !uuid.safeParse(storeId).success ||
    (cursor !== undefined && !uuid.safeParse(cursor).success)
  ) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  return asSeller((auth) =>
    apiFetch({
      path: `/stores/${storeId}/products`,
      schema: storeProductsSchema,
      ...auth,
      ...(cursor ? { query: { cursor } } : {}),
    }),
  );
}

export async function startImport(
  storeId: string,
  input: unknown,
): Promise<SellerResult<ImportView>> {
  const body = startSchema.safeParse(input);
  if (!uuid.safeParse(storeId).success || !body.success)
    return { ok: false, code: 'VALIDATION_FAILED' };
  return asSeller((auth) =>
    apiFetch({
      path: `/stores/${storeId}/import`,
      method: 'POST',
      schema: importViewSchema,
      ...auth,
      body: body.data,
    }),
  );
}

/** An import's progress, and every row once it has finished. */
export async function importStatus(
  storeId: string,
  importId: string,
): Promise<SellerResult<ImportView>> {
  if (!uuid.safeParse(storeId).success || !uuid.safeParse(importId).success) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  return asSeller((auth) =>
    apiFetch({ path: `/stores/${storeId}/imports/${importId}`, schema: importViewSchema, ...auth }),
  );
}

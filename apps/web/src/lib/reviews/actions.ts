'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import { ApiError, ApiShapeError, ApiUnreachableError } from '../api/errors';
import {
  reviewReportResultSchema,
  reviewRespondResultSchema,
  reviewWriteResultSchema,
  type ReviewWriteResult,
} from '../api/schemas';
import { readSession } from '../auth/session';
import { currentTenantId } from '../tenant';

/**
 * Reviews' actions on the web (ADR 061): the same endpoints as the app, with
 * the member's session. The API runs each in the store's own area and keeps
 * every rule (the contact, the window, one per store, who may reply).
 */

export type ReviewResult<T> =
  { ok: true; data: T } | { ok: false; code: string; details?: unknown };

const uuid = z.string().uuid();
const writeSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    text: z.string().trim().nullable(),
    photoIds: z.array(z.string().uuid()),
  })
  .strict();
const reportSchema = z
  .object({
    reasonCode: z.enum(['fake_review', 'harassment', 'spam', 'other']),
    details: z.string().trim().nullable(),
  })
  .strict();

async function asMember<T>(
  call: (auth: { tenantId: string; accessToken: string }) => Promise<T>,
): Promise<ReviewResult<T>> {
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

const invalid = { ok: false, code: 'VALIDATION_FAILED' } as const;

/** Write the viewer's review, or (`edit`) change it. */
export async function writeReview(
  storeId: string,
  input: unknown,
  edit: boolean,
): Promise<ReviewResult<ReviewWriteResult>> {
  const body = writeSchema.safeParse(input);
  if (!uuid.safeParse(storeId).success || !body.success) return invalid;
  const result = await asMember((auth) =>
    apiFetch({
      path: edit ? `/stores/${storeId}/reviews/mine` : `/stores/${storeId}/reviews`,
      method: edit ? 'PATCH' : 'POST',
      schema: reviewWriteResultSchema,
      body: { ...body.data, text: body.data.text || null },
      ...auth,
    }),
  );
  if (result.ok) revalidatePath('/store/[slug]', 'page');
  return result;
}

/** The store's reply (owner or manager; the API decides). */
export async function respondToReview(
  storeId: string,
  reviewId: string,
  text: string,
): Promise<ReviewResult<{ created: boolean }>> {
  const body = z.string().trim().min(1).safeParse(text);
  if (!uuid.safeParse(storeId).success || !uuid.safeParse(reviewId).success || !body.success)
    return invalid;
  const result = await asMember((auth) =>
    apiFetch({
      path: `/stores/${storeId}/reviews/${reviewId}/response`,
      method: 'PUT',
      schema: reviewRespondResultSchema,
      body: { text: body.data },
      ...auth,
    }),
  );
  if (result.ok) {
    revalidatePath('/seller/[storeId]/reviews', 'page');
    revalidatePath('/store/[slug]', 'page');
  }
  return result;
}

/** Report a review — nobody deletes one; a moderator decides. */
export async function reportReview(
  storeId: string,
  reviewId: string,
  input: unknown,
): Promise<ReviewResult<{ created: boolean }>> {
  const body = reportSchema.safeParse(input);
  if (!uuid.safeParse(storeId).success || !uuid.safeParse(reviewId).success || !body.success)
    return invalid;
  return asMember(async (auth) => {
    const r = await apiFetch({
      path: `/stores/${storeId}/reviews/${reviewId}/report`,
      method: 'POST',
      schema: reviewReportResultSchema,
      body: {
        reasonCode: body.data.reasonCode,
        ...(body.data.details ? { details: body.data.details } : {}),
      },
      ...auth,
    });
    return { created: r.created };
  });
}

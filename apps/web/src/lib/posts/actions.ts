'use server';

import { z } from 'zod';
import { apiFetch } from '../api/fetch';
import { ApiError, ApiShapeError, ApiUnreachableError } from '../api/errors';
import {
  geocodeResponseSchema,
  ownershipSchema,
  pointAreasSchema,
  postSchema,
  reverseGeocodeSchema,
  type GeocodeResult,
  type Ownership,
  type PointAreas,
  type Post,
  type ReverseGeocode,
} from '../api/schemas';
import { readSession } from '../auth/session';
import { currentTenantId } from '../tenant';
import type { PostError } from './errors';

/** A server action's answer: the data, or the API's code and details for a Bengali message. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: PostError };

const uuid = z.string().uuid();
const money = z.string().regex(/^\d+\.\d{2}$/);

/** Runs `call` as the signed-in seller, in this host's tenant (tokens never leave the server). */
async function asSeller<T>(
  call: (auth: { tenantId: string; accessToken: string }) => Promise<T>,
): Promise<ActionResult<T>> {
  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session) return { ok: false, error: { code: 'UNAUTHENTICATED', status: 401 } };
  if (!tenantId) return { ok: false, error: { code: 'TENANT_REQUIRED', status: 400 } };
  try {
    return { ok: true, data: await call({ tenantId, accessToken: session.accessToken }) };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: { code: error.code, details: error.details, status: error.status },
      };
    }
    if (error instanceof ApiUnreachableError) return { ok: false, error: { code: 'NETWORK' } };
    if (error instanceof ApiShapeError)
      return { ok: false, error: { code: 'UNEXPECTED_RESPONSE', status: 502 } };
    throw error;
  }
}

const invalid = { ok: false as const, error: { code: 'VALIDATION_FAILED', status: 400 } };

/** POST /posts {submit: true} with the draft's Idempotency-Key: a retry returns the same post. */
export async function createPost(
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<ActionResult<Post>> {
  if (!/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) return invalid;
  return asSeller((auth) =>
    apiFetch({
      path: '/posts',
      method: 'POST',
      schema: postSchema,
      ...auth,
      headers: { 'idempotency-key': idempotencyKey },
      body: { ...body, submit: true },
    }),
  );
}

/** PATCH, then submit a rejected/removed post again (it waits for a moderator — ADR 029). */
export async function updatePost(
  id: string,
  body: Record<string, unknown>,
): Promise<ActionResult<Post>> {
  if (!uuid.safeParse(id).success) return invalid;
  return asSeller(async (auth) => {
    const updated = await apiFetch({
      path: `/posts/${id}`,
      method: 'PATCH',
      schema: postSchema,
      ...auth,
      body,
    });
    if (
      updated.status === 'rejected' ||
      updated.status === 'removed' ||
      updated.status === 'draft'
    ) {
      return apiFetch({ path: `/posts/${id}/submit`, method: 'POST', schema: postSchema, ...auth });
    }
    return updated;
  });
}

export async function markSold(id: string, soldPrice: string | null): Promise<ActionResult<Post>> {
  if (!uuid.safeParse(id).success || (soldPrice !== null && !money.safeParse(soldPrice).success))
    return invalid;
  return asSeller((auth) =>
    apiFetch({
      path: `/posts/${id}/sold`,
      method: 'POST',
      schema: postSchema,
      ...auth,
      body: soldPrice === null ? {} : { soldPrice },
    }),
  );
}

/** Repost an expired post, or renew a live one inside the reminder window (ADR 031). */
export async function repost(id: string): Promise<ActionResult<Post>> {
  if (!uuid.safeParse(id).success) return invalid;
  return asSeller((auth) =>
    apiFetch({ path: `/posts/${id}/repost`, method: 'POST', schema: postSchema, ...auth }),
  );
}

export async function setHidden(id: string, hidden: boolean): Promise<ActionResult<Post>> {
  if (!uuid.safeParse(id).success) return invalid;
  return asSeller((auth) =>
    apiFetch({
      path: `/posts/${id}/${hidden ? 'hide' : 'unhide'}`,
      method: 'POST',
      schema: postSchema,
      ...auth,
    }),
  );
}

export async function deletePost(id: string): Promise<ActionResult<null>> {
  if (!uuid.safeParse(id).success) return invalid;
  return asSeller(async (auth) => {
    await apiFetch({ path: `/posts/${id}`, method: 'DELETE', schema: z.null(), ...auth });
    return null;
  });
}

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** Where a post at this point will be listed (boundary warning). */
export async function ownershipAt(lat: number, lng: number): Promise<ActionResult<Ownership>> {
  if (!point.safeParse({ lat, lng }).success) return invalid;
  return asSeller((auth) =>
    apiFetch({
      path: '/posts/ownership',
      schema: ownershipSchema,
      ...auth,
      query: { lat: String(lat), lng: String(lng) },
    }),
  );
}

const purposes = z.enum(['post_location', 'store_setup', 'place_marking']);
export type GeoPurpose = z.infer<typeof purposes>;

/** GET /geo/reverse for a picker: settings map each purpose to the fewest Barikoi fields (ADR 044). */
export async function reverseGeocode(
  lat: number,
  lng: number,
  purpose: GeoPurpose,
): Promise<ActionResult<ReverseGeocode>> {
  if (!point.safeParse({ lat, lng }).success || !purposes.safeParse(purpose).success) {
    return invalid;
  }
  return asSeller((auth) =>
    apiFetch({
      path: '/geo/reverse',
      schema: reverseGeocodeSchema,
      ...auth,
      query: { lat: String(lat), lng: String(lng), purpose },
    }),
  );
}

/** GET /locations/lookup: our own areas at the point — free, the picker's instant area name. */
export async function areasAt(lat: number, lng: number): Promise<ActionResult<PointAreas>> {
  if (!point.safeParse({ lat, lng }).success) return invalid;
  return asSeller((auth) =>
    apiFetch({
      path: '/locations/lookup',
      schema: pointAreasSchema,
      ...auth,
      query: { lat: String(lat), lng: String(lng) },
    }),
  );
}

export async function searchAddress(
  q: string,
  near: { lat: number; lng: number } | null,
): Promise<ActionResult<GeocodeResult[]>> {
  const query = q.trim();
  if (!query || query.length > 200) return invalid;
  return asSeller(async (auth) => {
    const response = await apiFetch({
      path: '/geo/autocomplete',
      schema: geocodeResponseSchema,
      ...auth,
      query: { q: query, ...(near ? { lat: String(near.lat), lng: String(near.lng) } : {}) },
    });
    return response.results;
  });
}

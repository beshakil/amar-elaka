import type { z } from 'zod';
import { env } from '../env';
import { ApiError, ApiShapeError, ApiUnreachableError, toApiError } from './errors';

// Transport tuning for a server-to-server call, not a business rule: the API
// owns every real threshold via platform_settings (CLAUDE.md rule 9).
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 150;

export interface ApiRequest<TSchema extends z.ZodTypeAny> {
  /** Path below the API base URL, e.g. `/roles`. */
  path: string;
  schema: TSchema;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string>;
  tenantId?: string | undefined;
  accessToken?: string | undefined;
}

/**
 * The single way this app talks to the API: timeout, one retry for a request
 * that is safe to repeat, a typed error for every failure mode, and a schema
 * check on the way out (CLAUDE.md rule 5). Dashboard reads are never cached —
 * an operator must see current data, not a revalidating snapshot.
 *
 * The response schemas are tied to the API's published OpenAPI types in
 * ./schemas.ts — see docs/decisions/021.
 */
export async function apiFetch<TSchema extends z.ZodTypeAny>(
  request: ApiRequest<TSchema>,
): Promise<z.infer<TSchema>> {
  const method = request.method ?? 'GET';
  const url = new URL(`${env().API_BASE_URL}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (request.tenantId) headers['x-tenant-id'] = request.tenantId;
  if (request.accessToken) headers.authorization = `Bearer ${request.accessToken}`;

  const init: RequestInit = {
    method,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  };

  const response = await send(url, init, method === 'GET');
  if (!response.ok) throw await toApiError(response);

  const payload: unknown = response.status === 204 ? null : await response.json();
  const parsed = request.schema.safeParse(payload);
  if (!parsed.success) throw new ApiShapeError(request.path, parsed.error);
  return parsed.data as z.infer<TSchema>;
}

/** Retries once, and only for a GET — replaying a POST could double-write. */
async function send(url: URL, init: RequestInit, retryable: boolean): Promise<Response> {
  try {
    const response = await fetch(url, init);
    if (retryable && response.status >= 500) {
      await delay(RETRY_DELAY_MS);
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    return response;
  } catch (cause) {
    if (!retryable) throw new ApiUnreachableError(cause);
    await delay(RETRY_DELAY_MS);
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (retryCause) {
      throw new ApiUnreachableError(retryCause);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { ApiError, ApiShapeError, ApiUnreachableError };

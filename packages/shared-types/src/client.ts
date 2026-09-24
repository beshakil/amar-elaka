import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './types.generated.js';

export type ApiPaths = paths;

/**
 * Typed fetch client for the Amar Elaka API. `baseUrl` is the caller's
 * concern (different per app/environment) — this only wires up the
 * generated route/schema types from `openapi.json`.
 */
export function createApiClient(options: ClientOptions) {
  return createClient<paths>(options);
}

export type ApiClient = ReturnType<typeof createApiClient>;

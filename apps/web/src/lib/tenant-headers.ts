/**
 * The contract between middleware.ts and the pages. Kept free of any
 * server-only import so the middleware bundle can use it.
 */
export const TENANT_ID_HEADER = 'x-tenant-id';
export const TENANT_RESOLUTION_HEADER = 'x-tenant-resolution';

export type TenantResolution =
  | { kind: 'resolved'; tenantId: string }
  /** The API answered: no tenant is served at this hostname. */
  | { kind: 'none' }
  /** The API could not be asked (down, timed out, 5xx). */
  | { kind: 'unavailable' };

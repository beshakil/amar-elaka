import { cache } from 'react';
import { apiFetch } from '../api/fetch';
import { bazarBoardSchema, emergencyPageSchema, type TenantConfig } from '../api/schemas';
import { revalidate } from '../listings/load';

/**
 * The local information pages (ADR 064). Both are public and short-cached:
 * the emergency page (national hotlines + local contacts near the area's
 * centre) and the bazar price board.
 */
export const emergencyPage = cache(async (tenant: TenantConfig) =>
  apiFetch({
    path: '/info/emergency',
    schema: emergencyPageSchema,
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
  }),
);

/** `bazar` (the market) or `agri` (farm inputs, ADR 065). */
export const bazarBoard = cache(async (tenant: TenantConfig, board: 'bazar' | 'agri' = 'bazar') =>
  apiFetch({
    path: '/bazar/board',
    query: { board },
    schema: bazarBoardSchema,
    tenantId: tenant.id,
    revalidate: revalidate(tenant, 'homeRevalidateSeconds'),
  }),
);

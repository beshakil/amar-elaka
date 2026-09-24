import type { CSSProperties } from 'react';
import type { TenantConfig } from './api/schemas';

/**
 * Per-tenant overrides for the brand tokens in globals.css, rendered as an
 * inline style on `<html>`. The config is fetched server-side, so these ship
 * in the initial HTML and a tenant's colours are correct in the first paint —
 * there is no client-side correction to flash.
 *
 * `branding` currently carries only `logoStorageKey`: the API has no brand
 * colour anywhere in its schema yet (the open item from
 * docs/decisions/002-mobile-app-architecture.md), so every tenant renders the
 * platform palette today. This is the one place that changes when it lands.
 */
export function tenantThemeVars(_config: TenantConfig | null): CSSProperties {
  return {};
}

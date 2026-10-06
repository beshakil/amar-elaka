import { apiFetch } from '../api/fetch';
import { mapConfigSchema, type MapConfig } from '../api/schemas';

/**
 * GET /map/config for a page that draws a map (ADR 043). A map is never worth
 * failing a page over: if the API can't answer, the page renders without a
 * base map (BaseMap shows a notice) and everything else still works.
 */
export async function loadMapConfig(): Promise<MapConfig | null> {
  try {
    return await apiFetch({ path: '/map/config', schema: mapConfigSchema });
  } catch {
    return null;
  }
}

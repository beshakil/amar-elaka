import { notFound } from 'next/navigation';
import { requireGrant } from '@/lib/auth/guards';
import type { Viewer } from '@/lib/auth/me';

/**
 * The heatmap is the tenant admins' (ADR 050): a marketer holds analytics:read
 * too, but the API refuses them this report, so the page does as well.
 */
const HEATMAP_ROLES: ReadonlySet<string> = new Set(['tenant_admin', 'partner_owner']);

export async function requireHeatmapViewer(): Promise<Viewer> {
  const viewer = await requireGrant({ module: 'analytics', action: 'read' });
  if (!HEATMAP_ROLES.has(viewer.permissions.role ?? '')) notFound();
  return viewer;
}

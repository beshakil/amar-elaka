import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { catalogCategorySchema, heatmapSchema, mapConfigSchema } from '@/lib/api/schemas';
import { requireHeatmapViewer } from './access';
import { HeatmapClient } from './heatmap-client';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * Demand next to supply (ADR 050): where people search and keep alerts, and
 * where listings and stores are, per grid cell of this tenant — read-only.
 * The API aggregates and hides thin cells; this page only draws them.
 */
export default async function HeatmapPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const viewer = await requireHeatmapViewer();
  const { category: raw } = await searchParams;
  const category = slug.safeParse(raw).success ? raw : undefined;
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const query = (type: 'demand' | 'supply') => ({ type, ...(category ? { category } : {}) });

  const [config, demand, supply, categories] = await Promise.all([
    apiFetch({ path: '/map/config', schema: mapConfigSchema, ...auth }),
    apiFetch({
      path: '/analytics/heatmap',
      schema: heatmapSchema,
      query: query('demand'),
      ...auth,
    }),
    apiFetch({
      path: '/analytics/heatmap',
      schema: heatmapSchema,
      query: query('supply'),
      ...auth,
    }),
    apiFetch({ path: '/categories', schema: z.array(catalogCategorySchema), ...auth }),
  ]);

  return (
    <HeatmapClient
      config={config}
      demand={demand}
      supply={supply}
      category={category ?? null}
      // Top-level listing categories (the filter includes each one's subcategories).
      categories={categories
        .filter((c) => c.parentId === null && c.kind !== 'module' && c.kind !== 'place')
        .map((c) => ({ slug: c.slug, name: c.name.bn }))}
    />
  );
}

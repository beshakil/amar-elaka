import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PermissionDeniedException } from '../rbac/rbac.exceptions';
import { SettingsService } from '../settings/settings.service';
import type { Heatmap, HeatmapQuery } from './dto/analytics.dto';

/** The tenant's admins and platform staff (heatmap_cells refuses everyone else too). */
const READERS: ReadonlySet<string> = new Set([
  'tenant_admin',
  'partner_owner',
  'platform_admin',
  'platform_support',
  'platform_finance',
]);

const CELL = z.object({
  geohash: z.string(),
  lat: z.number(),
  lng: z.number(),
  count: z.number(),
});

/**
 * Demand/supply heatmap (ADR 050): this tenant's searches (or listings) per
 * geohash cell, from heatmap_cells() (0045). Aggregated in the database —
 * no individual location ever leaves it — and only cells with at least
 * heatmap_min_cell_count distinct people.
 */
@Injectable()
export class HeatmapService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly settings: SettingsService,
  ) {}

  async heatmap(query: HeatmapQuery): Promise<Heatmap> {
    // A marketer holds analytics:read too; this map is the admins' alone.
    if (!READERS.has(this.context.require().role ?? 'anon')) {
      throw new PermissionDeniedException('analytics', 'read');
    }
    const tenantId = this.context.require().tenantId;
    const [minCellCount, windowDays, precision, cellsMax] = await Promise.all([
      this.settings.get('heatmap_min_cell_count', tenantId),
      this.settings.get('heatmap_window_days'),
      this.settings.get('heatmap_geohash_precision'),
      this.settings.get('heatmap_cells_max'),
    ]);
    const rows = await this.tenantDb.transaction(
      async (tx) =>
        z.array(CELL).parse([
          ...(await tx.execute(sql`
            select geohash, lat, lng, count
            from public.heatmap_cells(${query.type}, ${query.category ?? null}, ${precision}::integer,
                                      ${windowDays}::integer, ${minCellCount}::integer, ${cellsMax}::integer)`)),
        ]),
      { accessMode: 'read only' },
    );
    return {
      type: query.type,
      category: query.category ?? null,
      precision,
      minCellCount,
      windowDays,
      cells: rows,
    };
  }
}

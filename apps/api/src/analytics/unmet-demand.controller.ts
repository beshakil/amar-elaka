import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  HeatmapDto,
  HeatmapQueryDto,
  UnmetDemandDto,
  type Heatmap,
  type UnmetDemand,
} from './dto/analytics.dto';
import { HeatmapService } from './heatmap.service';
import { UnmetDemandService } from './unmet-demand.service';

/**
 * GET /api/v1/analytics/unmet-demand — tenant admins (and platform staff),
 * read-only JSON, no UI yet. The database function refuses anyone else,
 * whatever their permissions.
 */
@Controller({ path: 'analytics', version: '1' })
export class UnmetDemandController {
  constructor(
    private readonly unmetDemand: UnmetDemandService,
    private readonly heatmaps: HeatmapService,
  ) {}

  @Get('unmet-demand')
  @RequirePermission('analytics', 'read')
  @ApiOkResponse({ type: UnmetDemandDto })
  get(): Promise<UnmetDemand> {
    return this.unmetDemand.forTenant();
  }

  /**
   * Demand (searches, saved searches) or supply (live posts, stores) per grid
   * cell (ADR 050) — tenant admins only; never a point, never a cell with
   * fewer than heatmap_min_cell_count people.
   */
  @Get('heatmap')
  @RequirePermission('analytics', 'read')
  @ApiOkResponse({ type: HeatmapDto })
  heatmap(@Query() query: HeatmapQueryDto): Promise<Heatmap> {
    return this.heatmaps.heatmap(query);
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { UnmetDemandDto, type UnmetDemand } from './dto/analytics.dto';
import { UnmetDemandService } from './unmet-demand.service';

/**
 * GET /api/v1/analytics/unmet-demand — tenant admins (and platform staff),
 * read-only JSON, no UI yet. The database function refuses anyone else,
 * whatever their permissions.
 */
@Controller({ path: 'analytics', version: '1' })
export class UnmetDemandController {
  constructor(private readonly unmetDemand: UnmetDemandService) {}

  @Get('unmet-demand')
  @RequirePermission('analytics', 'read')
  @ApiOkResponse({ type: UnmetDemandDto })
  get(): Promise<UnmetDemand> {
    return this.unmetDemand.forTenant();
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { StoreActivityDto, StoreActivityQueryDto, type StoreActivity } from './dto/analytics.dto';
import { AnalyticsService } from './analytics.service';

/** /api/v1/tenant/analytics — tenant admins, marketers and platform staff; JSON only, no dashboard. */
@Controller({ path: 'tenant/analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Average posts per active store, per month (the input to a later "following feed" decision). */
  @Get('store-activity')
  @RequirePermission('analytics', 'read')
  @ApiOkResponse({ type: StoreActivityDto })
  storeActivity(@Query() query: StoreActivityQueryDto): Promise<StoreActivity> {
    return this.analytics.storeActivity(query);
  }
}

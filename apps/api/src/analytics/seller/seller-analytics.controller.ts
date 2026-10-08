import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { StoreIdParamDto } from '../../stores/dto/stores.dto';
import {
  AnalyticsQueryDto,
  SellerAnalyticsDto,
  type SellerAnalytics,
} from './dto/seller-analytics.dto';
import { SellerAnalyticsService } from './seller-analytics.service';

/** GET /api/v1/stores/:id/analytics — the store's numbers, for its owner and managers (ADR 055). */
@Controller({ path: 'stores', version: '1' })
export class StoreAnalyticsController {
  constructor(private readonly analytics: SellerAnalyticsService) {}

  @Get(':id/analytics')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: SellerAnalyticsDto })
  store(
    @Param() params: StoreIdParamDto,
    @Query() query: AnalyticsQueryDto,
  ): Promise<SellerAnalytics> {
    return this.analytics.forStore(params.id, query);
  }
}

/** GET /api/v1/posts/me/analytics — the caller's own posts, in every area (ADR 055). */
@Controller({ path: 'posts', version: '1' })
export class MyPostsAnalyticsController {
  constructor(private readonly analytics: SellerAnalyticsService) {}

  @Get('me/analytics')
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({ type: SellerAnalyticsDto })
  mine(@Query() query: AnalyticsQueryDto): Promise<SellerAnalytics> {
    return this.analytics.forMyPosts(query);
  }
}

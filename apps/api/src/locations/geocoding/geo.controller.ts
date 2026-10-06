import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { OptionalJwtAuthGuard } from '../../auth/guards/optional-jwt-auth.guard';
import { AllowAnyTenant } from '../../database/allow-any-tenant.decorator';
import { TenantContext } from '../../database/tenant-context';
import { PlatformAdmin } from '../../rbac/platform-admin.decorator';
import {
  GeoAutocompleteQueryDto,
  GeoAutocompleteResponseDto,
  GeoReverseQueryDto,
  GeoReverseResponseDto,
  GeoRouteBodyDto,
  GeoRouteResponseDto,
  GeoUsageQueryDto,
  GeoUsageResponseDto,
  type GeoAutocompleteResponse,
  type GeoReverseResponse,
  type GeoRouteResponse,
  type GeoUsageResponse,
} from './geo.dto';
import { GeoService } from './geo.service';
import { GeoUsageService } from './geo-usage.service';

/**
 * The only geo endpoints clients may call (ADR 044). Our own places,
 * landmarks, stores and areas answer first; Barikoi only when they can't,
 * within the daily budget, cached, logged. Nothing here ever fails because a
 * provider is down: our own data answers with `degraded: true`.
 */
@Controller({ path: 'geo', version: '1' })
@AllowAnyTenant()
@UseGuards(OptionalJwtAuthGuard)
export class GeoController {
  constructor(
    private readonly geo: GeoService,
    private readonly context: TenantContext,
  ) {}

  /** As-you-type place search. Clients debounce; the server limits per client. */
  @Get('autocomplete')
  @ApiOkResponse({ type: GeoAutocompleteResponseDto })
  autocomplete(
    @Query() query: GeoAutocompleteQueryDto,
    @Req() request: FastifyRequest,
  ): Promise<GeoAutocompleteResponse> {
    return this.geo.autocomplete(query, this.client(request));
  }

  /** Areas always (free); a street address only for a purpose that shows one, with its mapped fields. */
  @Get('reverse')
  @ApiOkResponse({ type: GeoReverseResponseDto })
  reverse(@Query() query: GeoReverseQueryDto): Promise<GeoReverseResponse> {
    return this.geo.reverse(query);
  }

  /** The road route — on an explicit tap only, never while panning. */
  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: GeoRouteResponseDto })
  route(@Body() body: GeoRouteBodyDto, @Req() request: FastifyRequest): Promise<GeoRouteResponse> {
    return this.geo.route(body, this.client(request));
  }

  /** Who is asking, for the per-client limits: the signed-in user, else the IP. */
  private client(request: FastifyRequest): string {
    const userId = this.context.current()?.userId;
    return userId ? `user:${userId}` : `ip:${request.ip}`;
  }
}

/** GET /analytics/geo-usage — the provider's cost, for platform staff (ADR 044). */
@Controller({ path: 'analytics', version: '1' })
export class GeoUsageController {
  constructor(private readonly usage: GeoUsageService) {}

  @Get('geo-usage')
  @PlatformAdmin()
  @ApiOkResponse({ type: GeoUsageResponseDto })
  geoUsage(@Query() query: GeoUsageQueryDto): Promise<GeoUsageResponse> {
    return this.usage.report(query);
  }
}

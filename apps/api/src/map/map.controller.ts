import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { MapConfigDto, type MapConfig } from './map-config.dto';
import { MapConfigService } from './map-config.service';
import {
  MapDistanceQueryDto,
  MapDistanceResponseDto,
  MapFeaturesQueryDto,
  MapFeaturesResponseDto,
  type MapDistanceResponse,
  type MapFeaturesResponse,
} from './map-features.dto';
import { MapFeaturesService } from './map-features.service';

/** The map (ADR 043, ADR 045): global, no login, no tenant. Never a geo provider call. */
@Controller({ path: 'map', version: '1' })
@AllowAnyTenant()
export class MapController {
  constructor(
    private readonly mapConfig: MapConfigService,
    private readonly mapFeatures: MapFeaturesService,
  ) {}

  /** The live tiles archive, asset base, label language and fallback style. */
  @Get('config')
  @ApiOkResponse({ type: MapConfigDto })
  config(): Promise<MapConfig> {
    return this.mapConfig.config();
  }

  /**
   * GeoJSON for a viewport from our own database: posts, stores, places,
   * landmarks and info, each a toggleable layer, clustered on the server at
   * low zoom. Radius-based from the viewport centre; tenants never filter it.
   */
  @Get('features')
  @ApiOkResponse({ type: MapFeaturesResponseDto })
  features(@Query() query: MapFeaturesQueryDto): Promise<MapFeaturesResponse> {
    return this.mapFeatures.features(query);
  }

  /** Straight-line distance, instantly (PostGIS). Road distance/ETA: POST /geo/route, on a tap only. */
  @Get('distance')
  @ApiOkResponse({ type: MapDistanceResponseDto })
  distance(@Query() query: MapDistanceQueryDto): Promise<MapDistanceResponse> {
    return this.mapFeatures.distance(query);
  }
}

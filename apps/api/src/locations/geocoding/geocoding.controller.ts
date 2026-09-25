import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AllowAnyTenant } from '../../database/allow-any-tenant.decorator';
import {
  GeocodeQueryDto,
  GeocodeResponseDto,
  PointQueryDto,
  ReverseGeocodeResponseDto,
  type GeocodeResponse,
  type ReverseGeocodeResponse,
} from '../dto/locations.dto';
import { GeocodingService } from './geocoding.service';

/**
 * Address ↔ coordinates. Never fails because the provider is down: answers
 * then come from our own area data with `degraded: true`.
 */
@Controller({ path: 'geocode', version: '1' })
@AllowAnyTenant()
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Get('forward')
  @ApiOkResponse({ type: GeocodeResponseDto })
  forward(@Query() query: GeocodeQueryDto): Promise<GeocodeResponse> {
    return this.geocoding.forward(query);
  }

  @Get('reverse')
  @ApiOkResponse({ type: ReverseGeocodeResponseDto })
  reverse(@Query() query: PointQueryDto): Promise<ReverseGeocodeResponse> {
    return this.geocoding.reverse({ lat: query.lat, lng: query.lng });
  }

  @Get('autocomplete')
  @ApiOkResponse({ type: GeocodeResponseDto })
  autocomplete(@Query() query: GeocodeQueryDto): Promise<GeocodeResponse> {
    return this.geocoding.autocomplete(query);
  }
}

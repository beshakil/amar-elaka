import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import {
  ChildrenQueryDto,
  LocationAreaDto,
  LocationDetailDto,
  LocationIdParamDto,
  PointLookupDto,
  PointQueryDto,
  ViewportQueryDto,
  ViewportResponseDto,
  type LocationArea,
  type LocationDetail,
  type PointLookup,
  type ViewportResponse,
} from './dto/locations.dto';
import { LocationsService } from './locations.service';

/**
 * Bangladesh's administrative hierarchy (global reference data, no login):
 * Country > Division > District > Upazila / City Corporation > Union / Pourashava.
 */
@Controller({ path: 'locations', version: '1' })
@AllowAnyTenant()
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  /** Cascading pickers: the children of `parentId`, or the divisions without it. */
  @Get()
  @ApiOkResponse({ type: LocationAreaDto, isArray: true })
  children(@Query() query: ChildrenQueryDto): Promise<LocationArea[]> {
    return this.locations.children(query.parentId);
  }

  /** Areas intersecting a map viewport, with simplified boundaries and attribution. */
  @Get('viewport')
  @ApiOkResponse({ type: ViewportResponseDto })
  viewport(@Query() query: ViewportQueryDto): Promise<ViewportResponse> {
    return this.locations.viewport(query.bbox, query.level);
  }

  /** Which division/district/upazila/union a point is in; inside the request's tenant or not. */
  @Get('lookup')
  @ApiOkResponse({ type: PointLookupDto })
  lookup(@Query() query: PointQueryDto): Promise<PointLookup> {
    return this.locations.lookup(query.lat, query.lng);
  }

  /** One area and its ancestors (to prefill a picker). */
  @Get(':id')
  @ApiOkResponse({ type: LocationDetailDto })
  detail(@Param() params: LocationIdParamDto): Promise<LocationDetail> {
    return this.locations.detail(params.id);
  }
}

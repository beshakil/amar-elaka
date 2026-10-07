import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import {
  OfflineAreasDto,
  OfflineMapManifestDto,
  type OfflineAreas,
  type OfflineMapManifest,
} from './offline-map.dto';
import { OfflineMapService } from './offline-map.service';

/**
 * /api/v1/map/offline (ADR 050): this tenant's downloadable map area. No
 * login (the files are public tiles); the tenant comes from X-Tenant-Id.
 */
@Controller({ path: 'map/offline', version: '1' })
export class OfflineMapController {
  constructor(private readonly offline: OfflineMapService) {}

  /** What to download, how big it is, and how to check it. */
  @Get()
  @ApiOkResponse({ type: OfflineMapManifestDto })
  manifest(): Promise<OfflineMapManifest> {
    return this.offline.manifest();
  }

  /** The area outlines the app keeps for naming a point without a network. */
  @Get('areas')
  @ApiOkResponse({ type: OfflineAreasDto })
  areas(): Promise<OfflineAreas> {
    return this.offline.areas();
  }
}

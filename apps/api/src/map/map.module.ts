import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { CacheService } from '../cache/cache.service';
import { LocationsModule } from '../locations/locations.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { MapConfigService } from './map-config.service';
import { MapController } from './map.controller';
import { MapFeaturesRepository } from './map-features.repository';
import { MapPreviewRepository } from './map-preview.repository';
import { MapPreviewService } from './map-preview.service';
import { MAP_FEATURES_CACHE, MapFeaturesService } from './map-features.service';
import { MapTilesRoutes } from './map-tiles.routes';

/**
 * The map (ADR 043, ADR 045): the self-hosted base map — one Bangladesh
 * .pmtiles archive served as a static file at /tiles, GET /map/config naming
 * the live one — and the map's data: GET /map/features (GeoJSON, clustered in
 * PostGIS, cached per tile-aligned box), GET /map/features/:layer/:id (a
 * preview: photo, phones, address — ADR 046) and GET /map/distance (PostGIS). Our
 * own data only: this module never reaches a geo provider.
 */
@Module({
  imports: [SettingsModule, CacheModule, LocationsModule, StorageModule],
  controllers: [MapController],
  providers: [
    MapConfigService,
    MapTilesRoutes,
    MapFeaturesService,
    MapFeaturesRepository,
    MapPreviewService,
    MapPreviewRepository,
    { provide: MAP_FEATURES_CACHE, useExisting: CacheService },
  ],
})
export class MapModule {}

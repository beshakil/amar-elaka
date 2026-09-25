import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { CacheService } from '../cache/cache.service';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { BarikoiGeocodingProvider } from './geocoding/barikoi.provider';
import { GeocodingController } from './geocoding/geocoding.controller';
import { GEOCODING_PROVIDER } from './geocoding/geocoding.port';
import { GEOCODING_CACHE, GeocodingService } from './geocoding/geocoding.service';
import { LocationsController } from './locations.controller';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';
import {
  PlatformTenantBoundaryController,
  TenantBoundaryAdminGuard,
} from './platform-tenant-boundary.controller';

/**
 * The location system (ADR 026): the administrative hierarchy and map
 * viewport, point lookups, tenant boundaries (polygon or centre + radius),
 * and geocoding behind a swappable provider (Barikoi) with a Redis cache and
 * a no-fail fallback. Swap the provider by rebinding GEOCODING_PROVIDER.
 */
@Module({
  imports: [SettingsModule, CacheModule, RbacModule],
  controllers: [LocationsController, GeocodingController, PlatformTenantBoundaryController],
  providers: [
    LocationsRepository,
    LocationsService,
    GeocodingService,
    TenantBoundaryAdminGuard,
    { provide: GEOCODING_PROVIDER, useClass: BarikoiGeocodingProvider },
    { provide: GEOCODING_CACHE, useExisting: CacheService },
  ],
  exports: [LocationsService],
})
export class LocationsModule {}

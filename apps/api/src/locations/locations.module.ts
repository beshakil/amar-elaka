import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { CacheService } from '../cache/cache.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RbacModule } from '../rbac/rbac.module';
import { SearchCoreModule } from '../search/search-core.module';
import { SettingsModule } from '../settings/settings.module';
import { GeoBudgetAlerts } from './geocoding/geo-budget-alerts';
import { GEO_BUDGET_STORE, RedisGeoBudgetStore } from './geocoding/geo-budget.store';
import { GeoCallLog } from './geocoding/geo-call-log';
import { GEO_PROVIDERS } from './geocoding/geo-provider.port';
import { GeoController, GeoUsageController } from './geocoding/geo.controller';
import { GEOCODING_CACHE, GeoService } from './geocoding/geo.service';
import { GeoUsageService } from './geocoding/geo-usage.service';
import { OwnGeoLookup } from './geocoding/own-geo-lookup';
import { BarikoiProvider } from './geocoding/providers/barikoi.provider';
import { NullProvider } from './geocoding/providers/null.provider';
import { LocationsController } from './locations.controller';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';
import {
  PlatformTenantBoundaryController,
  TenantBoundaryAdminGuard,
} from './platform-tenant-boundary.controller';

/**
 * The location system (ADR 026): the administrative hierarchy and map
 * viewport, point lookups, tenant boundaries (polygon or centre + radius) —
 * and the geo provider layer (ADR 044): GET /geo/autocomplete, GET
 * /geo/reverse, POST /geo/route, the only geo endpoints clients call. Own
 * data first; a provider (`geo_provider`: Barikoi, or the null provider)
 * only when needed, cached, within the daily call budget, logged, never
 * fatal. Add a provider by implementing GeoProvider and listing it in
 * GEO_PROVIDERS.
 */
@Module({
  imports: [
    SettingsModule,
    CacheModule,
    RbacModule,
    AuthModule,
    SearchCoreModule,
    NotificationsModule,
  ],
  controllers: [
    LocationsController,
    GeoController,
    GeoUsageController,
    PlatformTenantBoundaryController,
  ],
  providers: [
    LocationsRepository,
    LocationsService,
    GeoService,
    GeoUsageService,
    GeoCallLog,
    GeoBudgetAlerts,
    OwnGeoLookup,
    TenantBoundaryAdminGuard,
    BarikoiProvider,
    NullProvider,
    {
      provide: GEO_PROVIDERS,
      inject: [BarikoiProvider, NullProvider],
      useFactory: (barikoi: BarikoiProvider, none: NullProvider) => [barikoi, none],
    },
    { provide: GEO_BUDGET_STORE, useClass: RedisGeoBudgetStore },
    { provide: GEOCODING_CACHE, useExisting: CacheService },
  ],
  exports: [LocationsService],
})
export class LocationsModule {}

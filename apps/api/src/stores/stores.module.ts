import { Module } from '@nestjs/common';
import { AnalyticsCountersModule } from '../analytics/seller/analytics-counters.module';
import { AuthModule } from '../auth/auth.module';
import { EngagementModule } from '../engagement/engagement.module';
import { FeedModule } from '../feed/feed.module';
import { HoursModule } from '../hours/hours.module';
import { LocationsModule } from '../locations/locations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlacesModule } from '../places/places.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { TrustModule } from '../trust/trust.module';
import { StoreCatalogController } from './catalog/store-catalog.controller';
import { StoreCatalogService } from './catalog/store-catalog.service';
import { StoreImportController } from './import/store-import.controller';
import { StoreImportRepository } from './import/store-import.repository';
import { StoreImportService } from './import/store-import.service';
import { StorePageService } from './store-page.service';
import { StoresController } from './stores.controller';
import { StoresRepository } from './stores.repository';
import { StoresService } from './stores.service';

/**
 * Stores (ADR 054): create, profile, staff, moderation and the public page.
 * Reuses, never re-implements: hours and open-now (HoursModule), the owning
 * tenant (PostsModule's PostOwnershipService), the map pin and duplicate
 * check (PlacesModule), trust (TrustModule) and the feed's post cards.
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    StorageModule,
    LocationsModule,
    NotificationsModule,
    PostsModule,
    PlacesModule,
    HoursModule,
    FeedModule,
    TrustModule,
    AnalyticsCountersModule,
    EngagementModule,
  ],
  controllers: [StoresController, StoreImportController, StoreCatalogController],
  providers: [
    StoresService,
    StorePageService,
    StoresRepository,
    StoreImportService,
    StoreImportRepository,
    StoreCatalogService,
  ],
})
export class StoresModule {}

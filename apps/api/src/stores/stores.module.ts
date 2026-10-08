import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
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
  ],
  controllers: [StoresController],
  providers: [StoresService, StorePageService, StoresRepository],
})
export class StoresModule {}

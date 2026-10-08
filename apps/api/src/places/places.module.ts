import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HoursModule } from '../hours/hours.module';
import { LocationsModule } from '../locations/locations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { TrustModule } from '../trust/trust.module';
import { DuplicatesController } from './duplicates.controller';
import { DuplicatesRepository } from './duplicates.repository';
import { DuplicatesService } from './duplicates.service';
import { PlaceClaimsController } from './place-claims.controller';
import { PlaceClaimsService } from './place-claims.service';
import { PlaceModerationController } from './place-moderation.controller';
import { PlaceModerationRepository } from './place-moderation.repository';
import { PlaceModerationService } from './place-moderation.service';
import { PlacesController } from './places.controller';
import { PlacesRepository } from './places.repository';
import { PlacesService } from './places.service';

/**
 * User-contributed places, their revision history and the claim flow
 * (ADR 047), duplicates (ADR 048), reports and edit suggestions (ADR 051).
 * Uses PostsModule only for PostOwnershipService: a place is owned
 * by the tenant its location falls in, by the same rule as a post.
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    StorageModule,
    LocationsModule,
    HoursModule,
    NotificationsModule,
    PostsModule,
    TrustModule,
  ],
  controllers: [
    PlacesController,
    PlaceClaimsController,
    DuplicatesController,
    PlaceModerationController,
  ],
  providers: [
    PlacesService,
    PlaceClaimsService,
    PlacesRepository,
    DuplicatesService,
    DuplicatesRepository,
    PlaceModerationService,
    PlaceModerationRepository,
  ],
  // The stores module creates and keeps a store's map pin (ADR 054).
  exports: [PlacesRepository, DuplicatesService],
})
export class PlacesModule {}

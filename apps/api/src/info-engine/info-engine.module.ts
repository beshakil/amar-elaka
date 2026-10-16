import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngagementModule } from '../engagement/engagement.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsModule } from '../posts/posts.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { DirectoryService } from './directory.service';
import { GovServicesService } from './gov-services.service';
import {
  DirectoryController,
  GovServicesController,
  InfoModerationController,
  InfoServicesController,
  LostFoundController,
  NoticesController,
  OutagesController,
  TransportController,
} from './info-engine.controller';
import { InfoEngineReadModule } from './info-engine-read.module';
import { InfoModerationService } from './info-moderation.service';
import { InfoNotifier } from './info-notifier';
import { LostFoundService } from './lost-found.service';
import { NoticesService } from './notices.service';
import { OutagesService } from './outages.service';
import { PrayerService } from './prayer.service';
import { TransportService } from './transport.service';

/**
 * The info engine (ADR 065): outages, transport, notices (local, community,
 * advisory), lost & found, the government service guide, directories and
 * the prayer settings — one card contract, one moderation path, one expiry
 * job (InfoJobsService, in the worker), one stale rule per type. Reuses the
 * owning-tenant switch (PostsModule), the lead gate (EngagementModule) and
 * the media pipeline.
 */
@Module({
  imports: [
    AuthModule,
    SettingsModule,
    StorageModule,
    PostsModule,
    EngagementModule,
    NotificationsModule,
    InfoEngineReadModule,
  ],
  controllers: [
    InfoServicesController,
    OutagesController,
    NoticesController,
    LostFoundController,
    InfoModerationController,
    TransportController,
    GovServicesController,
    DirectoryController,
  ],
  providers: [
    OutagesService,
    NoticesService,
    LostFoundService,
    InfoModerationService,
    TransportService,
    GovServicesService,
    DirectoryService,
    PrayerService,
    InfoNotifier,
  ],
})
export class InfoEngineModule {}

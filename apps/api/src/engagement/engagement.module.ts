import { Module } from '@nestjs/common';
import { AnalyticsCountersModule } from '../analytics/seller/analytics-counters.module';
import { AuthModule } from '../auth/auth.module';
import { FeedModule } from '../feed/feed.module';
import { PostsModule } from '../posts/posts.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { ContactService } from './contact.service';
import { EngagementController, StoreContactController } from './engagement.controller';
import { EngagementRepository } from './engagement.repository';
import { ENGAGEMENT_STORE, RedisEngagementStore } from './engagement.store';
import { PostDetailService } from './post-detail.service';
import { PostViewsService } from './post-views.service';
import { ReportsService } from './reports.service';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';

/**
 * The buyer's side of a post (ADR 036): detail, views, contact reveals (the
 * leads lead billing will count), share links and reports. The view-count
 * flush runs in the worker (EngagementWorkerModule).
 */
@Module({
  imports: [
    AuthModule,
    SettingsModule,
    StorageModule,
    PostsModule,
    FeedModule,
    AnalyticsCountersModule,
  ],
  controllers: [EngagementController, StoreContactController, ShareController],
  providers: [
    EngagementRepository,
    PostDetailService,
    PostViewsService,
    ContactService,
    ReportsService,
    ShareService,
    { provide: ENGAGEMENT_STORE, useClass: RedisEngagementStore },
  ],
})
export class EngagementModule {}

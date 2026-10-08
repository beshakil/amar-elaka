import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PostsModule } from '../../posts/posts.module';
import { SettingsModule } from '../../settings/settings.module';
import { AnalyticsCountersModule } from './analytics-counters.module';
import {
  MyPostsAnalyticsController,
  StoreAnalyticsController,
} from './seller-analytics.controller';
import { SellerAnalyticsService } from './seller-analytics.service';

/** The seller's analytics screen (ADR 055): GET /stores/:id/analytics, GET /posts/me/analytics. */
@Module({
  imports: [AuthModule, SettingsModule, PostsModule, AnalyticsCountersModule],
  controllers: [StoreAnalyticsController, MyPostsAnalyticsController],
  providers: [SellerAnalyticsService],
})
export class SellerAnalyticsModule {}

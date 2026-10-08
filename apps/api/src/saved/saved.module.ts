import { Module } from '@nestjs/common';
import { AnalyticsCountersModule } from '../analytics/seller/analytics-counters.module';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { SavedController, StoreFollowsController } from './saved.controller';
import { SavedRepository } from './saved.repository';
import { SavedService } from './saved.service';

/** Saved items (posts, places, stores) and store follows (Q25, ADR 037). */
@Module({
  imports: [AuthModule, SettingsModule, StorageModule, PostsModule, AnalyticsCountersModule],
  controllers: [SavedController, StoreFollowsController],
  providers: [SavedService, SavedRepository],
  exports: [SavedRepository],
})
export class SavedModule {}

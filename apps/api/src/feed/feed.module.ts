import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { FeedController } from './feed.controller';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';

/** GET /api/v1/feed (ADR 035). Read-only; ranking lives in feed_posts (0030). */
@Module({
  imports: [SettingsModule, StorageModule, CacheModule],
  controllers: [FeedController],
  providers: [FeedService, FeedRepository],
  exports: [FeedService],
})
export class FeedModule {}

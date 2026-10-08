import { Module } from '@nestjs/common';
import { AnalyticsCountersModule } from '../analytics/seller/analytics-counters.module';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { SearchActivityService } from './query/search-activity.service';
import { SearchService } from './query/search.service';
import { SearchController } from './search.controller';
import { SearchCoreModule } from './search-core.module';

/**
 * The HTTP side of search: reads the index, and writes only the query log
 * (search_queries). Index writes live in the worker
 * (indexing/search-worker.module.ts), fed by the transactional outbox, so a
 * request never waits on — or fails because of — a Meilisearch write (ADR 025).
 */
@Module({
  imports: [
    AuthModule,
    SettingsModule,
    StorageModule,
    CacheModule,
    SearchCoreModule,
    AnalyticsCountersModule,
  ],
  controllers: [SearchController],
  providers: [SearchService, SearchActivityService],
})
export class SearchModule {}

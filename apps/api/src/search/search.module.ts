import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { MeilisearchEngine } from './engine/meilisearch-engine';
import { SEARCH_ENGINE } from './engine/search-engine.port';
import { SearchQueryRepository } from './query/search-query.repository';
import { SearchService } from './query/search.service';
import { SearchController } from './search.controller';

/**
 * The HTTP side of search: read-only. Index writes live in the worker
 * (indexing/search-worker.module.ts), fed by the transactional outbox, so a
 * request never waits on — or fails because of — Meilisearch (ADR 025).
 */
@Module({
  imports: [SettingsModule, StorageModule],
  controllers: [SearchController],
  providers: [
    SearchService,
    SearchQueryRepository,
    { provide: SEARCH_ENGINE, useClass: MeilisearchEngine },
  ],
})
export class SearchModule {}

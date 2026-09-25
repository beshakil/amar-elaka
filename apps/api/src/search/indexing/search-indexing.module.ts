import { Module } from '@nestjs/common';
import { SettingsModule } from '../../settings/settings.module';
import { SearchDocumentsRepository } from '../documents/search-documents.repository';
import { MeilisearchEngine } from '../engine/meilisearch-engine';
import { SEARCH_ENGINE } from '../engine/search-engine.port';
import { SearchIndexer } from './search-indexer.service';

/** Index writes (the indexer), shared by the worker and the reindex command. */
@Module({
  imports: [SettingsModule],
  providers: [
    SearchDocumentsRepository,
    SearchIndexer,
    { provide: SEARCH_ENGINE, useClass: MeilisearchEngine },
  ],
  exports: [SearchIndexer],
})
export class SearchIndexingModule {}

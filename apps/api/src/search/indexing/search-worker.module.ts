import { Module } from '@nestjs/common';
import { SettingsModule } from '../../settings/settings.module';
import { SearchIndexingModule } from './search-indexing.module';
import { SearchOutboxRelay } from './search-outbox.relay';
import { SearchProcessor } from './search.processor';
import { SearchSchedule } from './search-schedule';

/**
 * The worker side of search (WorkerModule only): the outbox relay, the
 * search_synced_at sweeper and settings upkeep. HTTP requests never write to
 * the index (ADR 025).
 */
@Module({
  imports: [SettingsModule, SearchIndexingModule],
  providers: [SearchOutboxRelay, SearchProcessor, SearchSchedule],
})
export class SearchWorkerModule {}

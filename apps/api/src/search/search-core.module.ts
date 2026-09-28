import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { MeilisearchEngine } from './engine/meilisearch-engine';
import { SEARCH_ENGINE } from './engine/search-engine.port';
import { SearchCriteriaService } from './query/search-criteria.service';
import { SearchMatcher } from './query/search-matcher';
import { SearchQueryRepository } from './query/search-query.repository';

/**
 * What a search means, shared by everything that searches (ADR 041): the
 * engine, SearchCriteriaService (a request or a saved search → criteria) and
 * SearchMatcher (criteria → matching documents). GET /search and the
 * saved-search matcher both import this, so there is one matcher.
 */
@Module({
  imports: [SettingsModule],
  providers: [
    SearchQueryRepository,
    SearchCriteriaService,
    SearchMatcher,
    { provide: SEARCH_ENGINE, useClass: MeilisearchEngine },
  ],
  exports: [SearchQueryRepository, SearchCriteriaService, SearchMatcher, SEARCH_ENGINE],
})
export class SearchCoreModule {}

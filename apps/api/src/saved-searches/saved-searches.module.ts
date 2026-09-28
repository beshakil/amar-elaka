import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeedModule } from '../feed/feed.module';
import { SearchCoreModule } from '../search/search-core.module';
import { SettingsModule } from '../settings/settings.module';
import { SavedSearchesController } from './saved-searches.controller';
import { SavedSearchesRepository } from './saved-searches.repository';
import { SavedSearchesService } from './saved-searches.service';

/**
 * /saved-searches (ADR 041). SearchCoreModule gives the same criteria rules
 * as GET /search; FeedModule the cards of the new results.
 */
@Module({
  imports: [AuthModule, SettingsModule, SearchCoreModule, FeedModule],
  controllers: [SavedSearchesController],
  providers: [SavedSearchesService, SavedSearchesRepository],
})
export class SavedSearchesModule {}

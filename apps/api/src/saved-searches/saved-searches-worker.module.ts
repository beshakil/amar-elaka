import { Module } from '@nestjs/common';
import { AnalyticsWorkerModule } from '../analytics/analytics-worker.module';
import { JobRunnerModule } from '../jobs/job-runner.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SearchCoreModule } from '../search/search-core.module';
import { SettingsModule } from '../settings/settings.module';
import { SavedSearchAutoPauseService } from './matching/saved-search-auto-pause.service';
import { SavedSearchMatcherService } from './matching/saved-search-matcher.service';
import { SavedSearchNotifierService } from './matching/saved-search-notifier.service';
import { SavedSearchesRepository } from './saved-searches.repository';
import { SavedSearchesProcessor } from './saved-searches.processor';
import { SavedSearchesSchedule } from './saved-searches.schedule';

/**
 * The worker side of saved searches (WorkerModule only, ADR 041): matching
 * through the shared SearchMatcher (SearchCoreModule), grouped notifications
 * through NotificationService's channels, auto-pause, and the unmet-demand
 * refresh.
 */
@Module({
  imports: [
    AnalyticsWorkerModule,
    JobRunnerModule,
    NotificationsModule,
    SearchCoreModule,
    SettingsModule,
  ],
  providers: [
    SavedSearchesRepository,
    SavedSearchMatcherService,
    SavedSearchNotifierService,
    SavedSearchAutoPauseService,
    SavedSearchesProcessor,
    SavedSearchesSchedule,
  ],
  exports: [SavedSearchMatcherService, SavedSearchNotifierService, SavedSearchAutoPauseService],
})
export class SavedSearchesWorkerModule {}

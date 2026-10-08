import { Module } from '@nestjs/common';
import { AnalyticsCountersModule } from '../analytics/seller/analytics-counters.module';
import { EngagementWorkerModule } from '../engagement/engagement-worker.module';
import { JobRunnerModule } from '../jobs/job-runner.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { DraftCleanupService } from './draft-cleanup.service';
import { PostExpiryReminderService } from './post-expiry-reminder.service';
import { PostExpiryService } from './post-expiry.service';
import { PostsRepository } from './posts.repository';
import { PostsSchedule } from './posts-schedule';
import { PostsProcessor } from './posts.processor';

/** The worker side of posts (WorkerModule only): expiry, expiry reminders and stale-draft cleanup (ADR 031), view-count flush (ADR 036). */
@Module({
  imports: [
    AnalyticsCountersModule,
    EngagementWorkerModule,
    JobRunnerModule,
    NotificationsModule,
    SettingsModule,
  ],
  providers: [
    PostsRepository,
    PostExpiryService,
    PostExpiryReminderService,
    DraftCleanupService,
    PostsProcessor,
    PostsSchedule,
  ],
})
export class PostsWorkerModule {}

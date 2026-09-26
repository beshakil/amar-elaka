import { Module } from '@nestjs/common';
import { PlatformAdminOnlyGuard } from '../categories/platform-admin-only';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { JobRunsRepository } from './job-runs.repository';
import { PlatformJobsController } from './platform-jobs.controller';
import { PlatformJobsService } from './platform-jobs.service';

/** The API side of the scheduled jobs (AppModule): health view, history, manual trigger. The runs themselves are the worker's. */
@Module({
  imports: [RbacModule, SettingsModule],
  controllers: [PlatformJobsController],
  providers: [PlatformJobsService, JobRunsRepository, PlatformAdminOnlyGuard],
})
export class PlatformJobsModule {}

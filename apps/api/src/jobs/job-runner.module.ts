import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { JobRunner } from './job-runner.service';
import { JobRunsRepository } from './job-runs.repository';

/** The JobRunner, for the worker modules whose processors run scheduled jobs. */
@Module({
  imports: [SettingsModule],
  providers: [JobRunner, JobRunsRepository],
  exports: [JobRunner],
})
export class JobRunnerModule {}

import { Module } from '@nestjs/common';
import { JobRunnerModule } from '../../jobs/job-runner.module';
import { SettingsModule } from '../../settings/settings.module';
import { GeoCallLog } from './geo-call-log';
import { GeoJobsProcessor, GeoJobsSchedule } from './geo-jobs.processor';

/** The worker side of the geo provider layer (WorkerModule only): log retention. */
@Module({
  imports: [JobRunnerModule, SettingsModule],
  providers: [GeoCallLog, GeoJobsProcessor, GeoJobsSchedule],
})
export class GeoWorkerModule {}

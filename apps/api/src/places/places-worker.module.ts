import { Module } from '@nestjs/common';
import { JobRunnerModule } from '../jobs/job-runner.module';
import { SettingsModule } from '../settings/settings.module';
import { DuplicatesProcessor, DuplicatesSchedule } from './duplicates.processor';
import { DuplicatesRepository } from './duplicates.repository';
import { DuplicatesService } from './duplicates.service';

/** The worker side of places (WorkerModule only): the nightly duplicate check. */
@Module({
  imports: [JobRunnerModule, SettingsModule],
  providers: [DuplicatesService, DuplicatesRepository, DuplicatesProcessor, DuplicatesSchedule],
})
export class PlacesWorkerModule {}

import { Module } from '@nestjs/common';
import { JobRunnerModule } from '../../jobs/job-runner.module';
import { SettingsModule } from '../../settings/settings.module';
import { MapConfigService } from '../map-config.service';
import { OfflineMapBuilder } from './offline-map.builder';
import { OfflineMapProcessor, OfflineMapSchedule } from './offline-map.processor';
import { OfflineMapRepository } from './offline-map.repository';
import { PMTILES_EXTRACTOR, PmtilesCli } from './pmtiles-cli';

/** The worker side of the map (WorkerModule only): cutting each tenant's offline file. */
@Module({
  imports: [JobRunnerModule, SettingsModule],
  providers: [
    MapConfigService,
    OfflineMapRepository,
    OfflineMapBuilder,
    OfflineMapProcessor,
    OfflineMapSchedule,
    { provide: PMTILES_EXTRACTOR, useClass: PmtilesCli },
  ],
  exports: [OfflineMapBuilder],
})
export class MapWorkerModule {}

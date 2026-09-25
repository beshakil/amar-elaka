import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { MediaMaintenanceService } from './media-maintenance.service';
import { MediaProcessingService } from './media-processing.service';
import { MediaProcessor } from './media.processor';
import { MediaSchedule } from './media-schedule';

/**
 * The worker side (WorkerModule only): processing with sharp, and the
 * scheduled orphan and purge sweeps. Kept out of the HTTP process so image
 * decoding never competes with request handling.
 */
@Module({
  imports: [SettingsModule, StorageModule],
  providers: [MediaProcessingService, MediaMaintenanceService, MediaProcessor, MediaSchedule],
})
export class MediaWorkerModule {}

import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { InfoEngineRepository } from './info-engine.repository';
import { InfoFeedService } from './info-feed.service';
import { InfoJobsService } from './info-jobs.service';
import { InfoMedia } from './info-media';
import { InfoScope } from './info-scope';

/**
 * The info engine's shared core (ADR 065): the repository, the scope, the
 * media resolver, the feed's cards and the expiry job — used by the API
 * module, the feed and the worker without pulling in the controllers.
 */
@Module({
  imports: [SettingsModule, StorageModule],
  providers: [InfoEngineRepository, InfoScope, InfoMedia, InfoFeedService, InfoJobsService],
  exports: [InfoEngineRepository, InfoScope, InfoMedia, InfoFeedService, InfoJobsService],
})
export class InfoEngineReadModule {}

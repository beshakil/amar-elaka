import { Module } from '@nestjs/common';
import { MediaWorkerModule } from '../../media/media-worker.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { PostsModule } from '../../posts/posts.module';
import { SettingsModule } from '../../settings/settings.module';
import { StorageModule } from '../../storage/storage.module';
import { StoreImportProcessor } from './store-import.processor';
import { StoreImportRepository } from './store-import.repository';
import { StoreImportRunner } from './store-import-runner.service';

/**
 * The worker side of bulk upload (WorkerModule only): rows become posts
 * through PostsService, photos go through the media pipeline (ADR 056).
 */
@Module({
  imports: [PostsModule, MediaWorkerModule, SettingsModule, StorageModule, NotificationsModule],
  providers: [StoreImportRepository, StoreImportRunner, StoreImportProcessor],
  exports: [StoreImportRunner],
})
export class StoreImportWorkerModule {}

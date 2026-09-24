import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaController } from './media.controller';
import { MediaUploadsService } from './media-uploads.service';
import { S3StorageService } from './s3-storage.service';
import { STORAGE_SERVICE } from './storage.ports';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [MediaController],
  providers: [{ provide: STORAGE_SERVICE, useClass: S3StorageService }, MediaUploadsService],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}

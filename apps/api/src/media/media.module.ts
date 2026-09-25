import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { RedisUploadRateLimiter, UPLOAD_RATE_LIMITER } from './upload-rate-limiter';

/** The HTTP side of the media pipeline (presign, confirm, status). */
@Module({
  imports: [AuthModule, SettingsModule, StorageModule],
  controllers: [MediaController],
  providers: [MediaService, { provide: UPLOAD_RATE_LIMITER, useClass: RedisUploadRateLimiter }],
})
export class MediaModule {}

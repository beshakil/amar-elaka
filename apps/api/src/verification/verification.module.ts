import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { VerificationModerationService } from './verification-moderation.service';
import {
  MyVerificationController,
  StoreVerificationController,
  VerificationModerationController,
} from './verification.controller';
import { VerificationRepository } from './verification.repository';
import { VerificationService } from './verification.service';

/**
 * Verification (ADR 062): identity (NID hash + selfie) and business (trade
 * licence + shop front), reviewed by the area's moderators with signed-URL
 * evidence; the badge levels are the 0058 functions'. The expiry, reminder
 * and purge jobs run in the notifications worker (VerificationJobsService).
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    StorageModule,
    MediaModule,
    PostsModule,
    NotificationsModule,
  ],
  controllers: [
    MyVerificationController,
    StoreVerificationController,
    VerificationModerationController,
  ],
  providers: [VerificationRepository, VerificationService, VerificationModerationService],
  exports: [VerificationRepository],
})
export class VerificationModule {}

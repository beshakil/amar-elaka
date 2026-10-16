import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsModule } from '../posts/posts.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { AppealsService } from './appeals.service';
import { BanNotifier } from './ban-notifier';
import {
  AccountBansController,
  AppealModerationController,
  BanModerationController,
  BlacklistRecommendationsController,
  ComplaintsController,
  PlatformAppealsController,
  PlatformBlacklistController,
  PublicAppealsController,
} from './bans.controller';
import { TrustModule } from '../trust/trust.module';
import { BanEffects } from './ban-effects';
import { BansRepository } from './bans.repository';
import { BansService } from './bans.service';
import { BlacklistService } from './blacklist.service';
import { ComplaintsService } from './complaints.service';

/**
 * Bans, appeals, the global blacklist and complaints (ADR 063, the Q15b
 * decision). Enforcement itself is in AuthModule (BanStateService, read by
 * both JWT guards); the jobs run in the notifications worker (BansJobsService).
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    SettingsModule,
    CacheModule,
    PostsModule,
    NotificationsModule,
    TrustModule,
  ],
  controllers: [
    AccountBansController,
    PublicAppealsController,
    BanModerationController,
    AppealModerationController,
    PlatformAppealsController,
    BlacklistRecommendationsController,
    PlatformBlacklistController,
    ComplaintsController,
  ],
  providers: [
    BanEffects,
    BansRepository,
    BanNotifier,
    BansService,
    AppealsService,
    BlacklistService,
    ComplaintsService,
  ],
  exports: [BansRepository, BanNotifier],
})
export class BansModule {}

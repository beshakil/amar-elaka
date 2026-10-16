import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngagementModule } from '../engagement/engagement.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PostsModule } from '../posts/posts.module';
import { SettingsModule } from '../settings/settings.module';
import { BazarService } from './bazar.service';
import { BloodAlertsService } from './blood-alerts.service';
import { BloodNotifier } from './blood-notifier';
import { BloodService } from './blood.service';
import { EmergencyService } from './emergency.service';
import { InfoReadModule } from './info-read.module';
import { BazarController, BloodController, EmergencyController } from './info.controller';

/**
 * Local information services (ADR 064): emergency contacts, blood donors and
 * urgent requests, daily bazar prices. Reuses, never re-implements: the
 * owning-tenant switch (PostsModule), the lead gate (EngagementModule) and
 * notifications. The scheduled side (alerts, expiry) runs in the worker
 * (InfoWorkerModule).
 */
@Module({
  imports: [
    AuthModule,
    SettingsModule,
    PostsModule,
    EngagementModule,
    NotificationsModule,
    InfoReadModule,
  ],
  controllers: [EmergencyController, BloodController, BazarController],
  providers: [EmergencyService, BloodService, BloodAlertsService, BloodNotifier, BazarService],
})
export class InfoModule {}

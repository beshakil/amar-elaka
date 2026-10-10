import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { SettingsModule } from '../../settings/settings.module';
import { NotificationsRepository } from '../notifications.repository';
import { NotificationPreferencesController } from '../preferences/notification-preferences.controller';
import { NotificationPreferencesService } from '../preferences/notification-preferences.service';
import { InboxController } from './inbox.controller';
import { InboxRepository } from './inbox.repository';
import { InboxService } from './inbox.service';

/**
 * The user's side of notifications over HTTP: the in-app inbox (GET
 * /notifications), notification preferences and the device push token
 * (/me/…, ADR 059). Apart from NotificationsModule, which senders import,
 * and NotificationsWorkerModule, which delivers.
 */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [InboxController, NotificationPreferencesController],
  providers: [
    InboxService,
    InboxRepository,
    NotificationsRepository,
    NotificationPreferencesService,
  ],
})
export class InboxModule {}

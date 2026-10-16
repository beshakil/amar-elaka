import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { BloodAlertsService } from './blood-alerts.service';
import { BloodNotifier } from './blood-notifier';
import { InfoReadModule } from './info-read.module';

/**
 * The worker's side of the blood service (ADR 064): alert-blood-donors and
 * expire-blood-requests, run by the notifications processor.
 */
@Module({
  imports: [SettingsModule, NotificationsModule, InfoReadModule],
  providers: [BloodAlertsService, BloodNotifier],
  exports: [BloodAlertsService],
})
export class InfoWorkerModule {}

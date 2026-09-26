import { Module } from '@nestjs/common';
import { InAppNotificationChannel } from './in-app.channel';
import { NOTIFICATION_CHANNELS } from './notification-channel';
import { NotificationService } from './notification.service';

/** Outgoing notifications. Add a channel (push, SMS) to NOTIFICATION_CHANNELS; senders don't change. */
@Module({
  providers: [
    InAppNotificationChannel,
    {
      provide: NOTIFICATION_CHANNELS,
      inject: [InAppNotificationChannel],
      useFactory: (inApp: InAppNotificationChannel) => [inApp],
    },
    NotificationService,
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}

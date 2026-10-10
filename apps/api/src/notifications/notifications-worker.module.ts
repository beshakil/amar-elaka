import { Module } from '@nestjs/common';
import { SmsProviderModule } from '../auth/otp/sms/sms-provider.module';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { JobRunnerModule } from '../jobs/job-runner.module';
import { MailModule } from '../mail/mail.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailNotificationChannel } from './channels/email.channel';
import { PushNotificationChannel } from './channels/push.channel';
import { SmsNotificationChannel } from './channels/sms.channel';
import { InAppNotificationChannel } from './in-app.channel';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './notification-channel';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotificationOutboxRelay } from './notification-outbox.relay';
import { NotificationsModule } from './notifications.module';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsSchedule } from './notifications.schedule';
import { FcmPushProvider } from './push/fcm-push.provider';
import { LocalPushProvider } from './push/local-push.provider';
import { PUSH_PROVIDER, type PushProvider } from './push/push-provider';
import { NotificationTexts } from './templates/notification-texts';

/**
 * The delivering side (WorkerModule only, ADR 059): the dispatcher, the
 * in-app inbox and the push / SMS / email channels (NOTIFICATION_CHANNELS —
 * a new channel is one more entry; nothing that sends changes), the push
 * provider (PUSH_PROVIDER env: local logs, fcm sends), and the price-drop
 * outbox relay.
 */
@Module({
  imports: [JobRunnerModule, SettingsModule, SmsProviderModule, MailModule, NotificationsModule],
  providers: [
    NotificationsRepository,
    NotificationTexts,
    InAppNotificationChannel,
    PushNotificationChannel,
    SmsNotificationChannel,
    EmailNotificationChannel,
    LocalPushProvider,
    {
      provide: PUSH_PROVIDER,
      inject: [APP_CONFIG, LocalPushProvider],
      useFactory: (env: Env, local: LocalPushProvider): PushProvider =>
        env.PUSH_PROVIDER === 'fcm'
          ? new FcmPushProvider({
              serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
              apiUrl: env.FCM_API_URL,
              timeoutMs: env.FCM_TIMEOUT_MS,
            })
          : local,
    },
    {
      provide: NOTIFICATION_CHANNELS,
      inject: [PushNotificationChannel, SmsNotificationChannel, EmailNotificationChannel],
      useFactory: (...channels: NotificationChannel[]) => channels,
    },
    NotificationDispatcher,
    NotificationOutboxRelay,
    NotificationsProcessor,
    NotificationsSchedule,
  ],
  exports: [NotificationDispatcher, NotificationOutboxRelay, NotificationsRepository],
})
export class NotificationsWorkerModule {}

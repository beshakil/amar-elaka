import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type OutgoingNotification,
} from './notification-channel';

/**
 * Sends a notification through every registered channel. Called after the
 * action it reports has committed; a channel failure is logged, never thrown
 * — a moderator's decision must not fail because a notification couldn't go
 * out.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: readonly NotificationChannel[],
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationService.name);
  }

  async send(notification: OutgoingNotification): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.deliver(notification);
        } catch (error) {
          this.logger.error(
            {
              err: error,
              channel: channel.name,
              type: notification.type,
              entityId: notification.entityId,
            },
            'notification delivery failed',
          );
        }
      }),
    );
  }
}

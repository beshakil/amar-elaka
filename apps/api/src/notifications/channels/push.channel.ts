import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { ChannelMessage, ChannelOutcome, NotificationChannel } from '../notification-channel';
import { NotificationsRepository } from '../notifications.repository';
import { PUSH_PROVIDER, PushTransientError, type PushProvider } from '../push/push-provider';

/**
 * Push to every device the user registered (FCM: Android, iOS, the web).
 * A token FCM reports dead is removed from user_devices at once (the device
 * row stays; the app registers a fresh token on its next start). Sent when
 * any device took it; undeliverable when none could (no device, every
 * token dead); a transient FCM failure with nothing sent throws, and the
 * delivery job is retried.
 */
@Injectable()
export class PushNotificationChannel implements NotificationChannel {
  readonly name = 'push';

  constructor(
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    private readonly repo: NotificationsRepository,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PushNotificationChannel.name);
  }

  async deliver(message: ChannelMessage): Promise<ChannelOutcome> {
    const tokens = await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.pushTokens(tx, message.userId), {
        accessMode: 'read only',
      }),
    );
    if (tokens.length === 0)
      return { status: 'undeliverable', recipient: 'no device', reason: 'no_device' };

    const invalid: string[] = [];
    let sent = 0;
    let lastId: string | null = null;
    let transient: PushTransientError | undefined;
    for (const device of tokens) {
      try {
        const result = await this.provider.send({
          token: device.token,
          platform: device.platform,
          title: message.title,
          body: message.body,
          data: message.data,
          collapseKey: message.collapseKey,
          urgent: message.urgent,
        });
        if (result.ok) {
          sent += 1;
          lastId = result.messageId;
        } else {
          invalid.push(device.token);
        }
      } catch (error) {
        if (error instanceof PushTransientError) transient = error;
        else
          this.logger.warn(
            { err: error, deliveryId: message.deliveryId },
            'push refused for one device',
          );
      }
    }
    if (invalid.length > 0) {
      const removed = await this.asSystem(() =>
        this.tenantDb.transaction((tx) => this.repo.removeTokens(tx, invalid)),
      );
      this.logger.info(
        { userId: message.userId, removed },
        'removed push tokens FCM reported invalid',
      );
    }
    const recipient = `${sent}/${tokens.length} devices`;
    if (sent > 0) return { status: 'sent', recipient, providerMessageId: lastId };
    if (transient) throw transient;
    return {
      status: 'undeliverable',
      recipient,
      reason: invalid.length > 0 ? 'invalid_tokens' : 'refused',
    };
  }

  private asSystem<T>(work: () => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, work);
  }
}

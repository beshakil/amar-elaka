import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { MailService } from '../../mail/mail.service';
import type { ChannelMessage, ChannelOutcome, NotificationChannel } from '../notification-channel';
import { NotificationsRepository } from '../notifications.repository';

/** a***@example.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local ?? '').slice(0, 1)}***@${domain ?? ''}`;
}

/**
 * Email through the Month 1 MailService: the `notice` template (heading +
 * body) with the title as the subject, on the mail queue (its own retries
 * and dead-letter queue). Only to a verified address.
 */
@Injectable()
export class EmailNotificationChannel implements NotificationChannel {
  readonly name = 'email';

  constructor(
    private readonly mail: MailService,
    private readonly repo: NotificationsRepository,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
  ) {}

  async deliver(message: ChannelMessage): Promise<ChannelOutcome> {
    const { email } = await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx) => this.repo.contact(tx, message.userId), {
        accessMode: 'read only',
      }),
    );
    if (!email)
      return { status: 'undeliverable', recipient: 'no email', reason: 'no_verified_email' };
    const heading = message.title ?? '';
    await this.mail.send(email, 'notice', { subject: heading, heading, body: message.body });
    return { status: 'sent', recipient: maskEmail(email), providerMessageId: null };
  }
}

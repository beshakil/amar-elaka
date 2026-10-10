import { Inject, Injectable } from '@nestjs/common';
import { SMS_PROVIDER, type SmsProvider } from '../../auth/otp/sms/sms-provider.interface';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import type { ChannelMessage, ChannelOutcome, NotificationChannel } from '../notification-channel';
import { NotificationsRepository } from '../notifications.repository';

// settings-exempt: SMS encoding facts (GSM-7 160/153, UCS-2 70/67 characters per segment)
const GSM_SINGLE = 160;
// settings-exempt: see above
const GSM_MULTI = 153;
// settings-exempt: see above
const UCS2_SINGLE = 70;
// settings-exempt: see above
const UCS2_MULTI = 67;
// settings-exempt: the last ASCII code point — beyond it an SMS is UCS-2
const ASCII_MAX = 0x7f;
// settings-exempt: how much of a phone number the delivery log keeps (+8801 … last three)
const MASK_PREFIX = 5;
// settings-exempt: see above
const MASK_SUFFIX = 3;

/** Segments an SMS takes: Bengali (any non-ASCII) is UCS-2, 70 a part. */
export function smsSegments(text: string): number {
  const chars = [...text].length;
  const unicode = [...text].some((ch) => ch.codePointAt(0)! > ASCII_MAX);
  const [single, multi] = unicode ? [UCS2_SINGLE, UCS2_MULTI] : [GSM_SINGLE, GSM_MULTI];
  return chars <= single ? 1 : Math.ceil(chars / multi);
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, MASK_PREFIX)}${'•'.repeat(Math.max(phone.length - MASK_PREFIX - MASK_SUFFIX, 0))}${phone.slice(-MASK_SUFFIX)}`;
}

/**
 * SMS through the Month 1 SmsProvider (BulkSMSBD, ADR 053). Only types that
 * may use it ever get here (delivery-policy.ts: SMS-eligible or listed by a
 * platform admin — SMS costs money); the cost is billed to the tenant the
 * notification came from (billed_tenant_id), segments recorded. A gateway
 * failure throws and the delivery job retries.
 */
@Injectable()
export class SmsNotificationChannel implements NotificationChannel {
  readonly name = 'sms';

  constructor(
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    private readonly repo: NotificationsRepository,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
  ) {}

  async deliver(message: ChannelMessage): Promise<ChannelOutcome> {
    const { phone } = await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx) => this.repo.contact(tx, message.userId), {
        accessMode: 'read only',
      }),
    );
    if (!phone)
      return { status: 'undeliverable', recipient: 'no phone', reason: 'no_verified_phone' };
    await this.provider.send(phone, message.body);
    return {
      status: 'sent',
      recipient: maskPhone(phone),
      providerMessageId: null,
      smsSegments: smsSegments(message.body),
    };
  }
}

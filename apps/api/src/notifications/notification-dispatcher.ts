import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { DomainException } from '../common/exceptions/domain-exception';
import { SCHEDULE_TIMEZONE } from '../common/schedule-timezone';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import {
  JOB_DELIVER_NOTIFICATION,
  QUEUE_NOTIFICATIONS,
  type DeliverNotificationJob,
} from '../queue/queue.types';
import { SettingsService } from '../settings/settings.service';
import { chooseChannels, overCap, quietHoursEnd, startOfLocalDay } from './delivery-policy';
import { InAppNotificationChannel } from './in-app.channel';
import {
  NOTIFICATION_CHANNELS,
  type ChannelMessage,
  type InterruptChannel,
  type NotificationChannel,
  type NotificationType,
  type OutgoingNotification,
} from './notification-channel';
import { NotificationsRepository } from './notifications.repository';
import { NotificationTexts } from './templates/notification-texts';

// settings-exempt: unit conversion
const MS_PER_MINUTE = 60_000;

/** The delivery row isn't visible yet (its transaction is still committing): retry. */
export class DeliveryNotReadyError extends DomainException {
  readonly code = 'NOTIFICATION_DELIVERY_NOT_READY';
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(deliveryId: string) {
    super(`Delivery ${deliveryId} is not committed yet.`);
  }
}

export interface DispatchResult {
  notificationId: string | null;
  collapsed: boolean;
  channels: InterruptChannel[];
  /** Over a daily cap: the inbox row only. */
  capped: boolean;
  /** Quiet hours: when the held channels go out. */
  deferredUntil: Date | null;
}

/**
 * The worker side of NotificationService (ADR 059).
 *
 * dispatch(), one `notify` job, in one transaction as `system`:
 *  1. the type's rules and the recipient (an inactive user gets nothing);
 *  2. the inbox row — new, or collapsed into an unread one of the same type
 *     and key inside notification_collapse_window_minutes; a used dedupe key
 *     ends it here;
 *  3. channels: type defaults × the user's preferences × what they can be
 *     reached on; SMS only where allowed (delivery-policy.ts);
 *  4. caps: over notification_daily_cap or the type's cap, the inbox row is
 *     all there is (urgent types exempt);
 *  5. quiet hours (the tenant's, its timezone): a non-urgent push or SMS is
 *     held until they end — a delayed job; urgent types go now;
 *  6. one notification_deliveries row and one `deliver-notification` job per
 *     channel, queued inside the transaction (a job that runs before the
 *     commit retries — no delivery is ever lost between the two).
 *
 * deliver(), one `deliver-notification` job: renders the channel's template
 * from the row as it is now (a held push sent at 08:00 says "৫টি নতুন
 * মেসেজ" if more came meanwhile), sends, records the outcome. A transient
 * failure throws: BullMQ retries with backoff; the last failure marks the
 * delivery failed (markFailed).
 */
@Injectable()
export class NotificationDispatcher {
  private readonly channels: Map<string, NotificationChannel>;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: NotificationsRepository,
    private readonly inApp: InAppNotificationChannel,
    private readonly texts: NotificationTexts,
    private readonly settings: SettingsService,
    @Inject(NOTIFICATION_CHANNELS) channels: readonly NotificationChannel[],
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly queue: Queue<DeliverNotificationJob>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationDispatcher.name);
    this.channels = new Map(channels.map((c) => [c.name, c]));
  }

  async dispatch(n: OutgoingNotification, now = new Date()): Promise<DispatchResult> {
    const tenantId = n.tenantId ?? undefined;
    const [windowMinutes, dailyCap, typeCaps, smsExtra, quietStart, quietEnd] = await Promise.all([
      this.settings.get('notification_collapse_window_minutes', tenantId),
      this.settings.get('notification_daily_cap', tenantId),
      this.settings.get('notification_type_daily_caps', tenantId),
      this.settings.get('notification_sms_extra_types'),
      this.settings.get('notification_quiet_hours_start', tenantId),
      this.settings.get('notification_quiet_hours_end', tenantId),
    ]);
    const nothing: DispatchResult = {
      notificationId: null,
      collapsed: false,
      channels: [],
      capped: false,
      deferredUntil: null,
    };

    return this.asSystem(() =>
      this.tenantDb.transaction(async (tx) => {
        const rules = await this.repo.typeRules(tx, n.type);
        if (!rules) {
          this.logger.error({ type: n.type }, 'unknown or inactive notification type');
          return nothing;
        }
        const recipient = await this.repo.recipient(tx, n.userId);
        if (!recipient?.active) return nothing;

        const collapseKey = rules.collapsible ? (n.collapse?.key ?? n.type) : null;
        const record = await this.inApp.record(tx, n, {
          locale: recipient.locale,
          collapseKey,
          collapseSince:
            collapseKey !== null && windowMinutes > 0
              ? new Date(now.getTime() - windowMinutes * MS_PER_MINUTE)
              : null,
          at: now,
        });
        if (!record) return nothing; // dedupe key already used

        const base = { notificationId: record.notificationId, collapsed: record.collapsed };
        let channels = chooseChannels(
          rules,
          await this.repo.preferences(tx, n.userId, n.type),
          recipient,
          smsExtra,
        );
        if (record.collapsed) {
          // A push still held for this row carries the new count when it goes.
          const waiting = await Promise.all(
            channels.map((c) => this.repo.hasWaitingDelivery(tx, record.notificationId, c)),
          );
          channels = channels.filter((_, i) => !waiting[i]);
        }
        if (channels.length === 0)
          return { ...base, channels: [], capped: false, deferredUntil: null };

        const timeZone =
          (n.tenantId ? await this.repo.tenantTimezone(tx, n.tenantId) : undefined) ??
          SCHEDULE_TIMEZONE;
        const sent = await this.repo.sentSince(
          tx,
          n.userId,
          n.type,
          startOfLocalDay(now, timeZone),
        );
        if (overCap(rules, sent, { daily: dailyCap, perType: typeCaps })) {
          return { ...base, channels: [], capped: true, deferredUntil: null };
        }

        const quietUntil = rules.urgent ? null : quietHoursEnd(now, quietStart, quietEnd, timeZone);
        for (const channel of channels) {
          const held = channel === 'push' || channel === 'sms' ? quietUntil : null;
          const deliveryId = await this.repo.insertDelivery(tx, {
            notificationId: record.notificationId,
            userId: n.userId,
            tenantId: n.tenantId ?? null,
            channel,
            provider: this.providerOf(channel),
            scheduledFor: held,
          });
          await this.queue.add(
            JOB_DELIVER_NOTIFICATION,
            { deliveryId },
            {
              jobId: `deliver-${deliveryId}`,
              ...(held ? { delay: Math.max(0, held.getTime() - now.getTime()) } : {}),
            },
          );
        }
        const anyHeld = channels.some((c) => c === 'push' || c === 'sms');
        return { ...base, channels, capped: false, deferredUntil: anyHeld ? quietUntil : null };
      }),
    );
  }

  async deliver(deliveryId: string): Promise<'sent' | 'undeliverable' | 'skipped'> {
    const prepared = await this.asSystem(() =>
      this.tenantDb.transaction(
        async (tx) => {
          const row = await this.repo.delivery(tx, deliveryId);
          if (!row) return undefined;
          if (row.status_code !== 'queued') return 'done' as const;
          return { row, message: await this.message(tx, row) };
        },
        { accessMode: 'read only' },
      ),
    );
    if (prepared === undefined) throw new DeliveryNotReadyError(deliveryId);
    if (prepared === 'done') return 'skipped';
    const { row, message } = prepared;
    if (!message) {
      await this.finish(deliveryId, row.notification_id, row.channel_code, {
        status: 'undeliverable',
        recipient: '',
        reason: 'no_template',
      });
      return 'undeliverable';
    }
    const channel = this.channels.get(row.channel_code);
    if (!channel) throw new Error(`no ${row.channel_code} channel registered`);
    const outcome = await channel.deliver(message);
    await this.finish(deliveryId, row.notification_id, row.channel_code, outcome);
    return outcome.status;
  }

  /** The job's last attempt failed: the delivery is failed, with its error. */
  async markFailed(deliveryId: string, error: string): Promise<void> {
    await this.asSystem(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.finishDelivery(tx, deliveryId, { status: 'failed', error }),
      ),
    );
  }

  /** An attempt failed and will be retried: counted, with its error. */
  async noteAttempt(deliveryId: string, error: string): Promise<void> {
    await this.asSystem(() =>
      this.tenantDb.transaction((tx) => this.repo.noteAttempt(tx, deliveryId, error)),
    );
  }

  private async message(
    tx: DatabaseTransaction,
    row: NonNullable<Awaited<ReturnType<NotificationsRepository['delivery']>>>,
  ): Promise<ChannelMessage | undefined> {
    const text = await this.texts.render(tx, {
      type: row.type_code,
      channel: row.channel_code,
      locale: row.preferred_locale,
      params: row.params,
      count: row.collapse_count,
    });
    if (!text) return undefined;
    return {
      deliveryId: row.id,
      notificationId: row.notification_id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      type: row.type_code as NotificationType,
      title: text.title,
      body: text.body,
      deepLink: row.deep_link,
      data: {
        type: row.type_code,
        notificationId: row.notification_id,
        deepLink: row.deep_link ?? '',
        count: String(row.collapse_count),
      },
      collapseKey: row.collapse_key ?? `${row.type_code}:${row.notification_id}`,
      urgent: row.is_urgent,
    };
  }

  private async finish(
    deliveryId: string,
    notificationId: string,
    channel: InterruptChannel,
    outcome: Awaited<ReturnType<NotificationChannel['deliver']>>,
  ): Promise<void> {
    await this.asSystem(() =>
      this.tenantDb.transaction(async (tx) => {
        await this.repo.finishDelivery(tx, deliveryId, {
          status: outcome.status,
          recipient: outcome.recipient,
          ...(outcome.status === 'sent'
            ? {
                providerMessageId: outcome.providerMessageId,
                smsSegments: outcome.smsSegments ?? null,
              }
            : { error: outcome.reason }),
        });
        if (outcome.status === 'sent') await this.repo.addChannelSent(tx, notificationId, channel);
      }),
    );
  }

  private providerOf(channel: InterruptChannel): string {
    return channel === 'push' ? 'fcm' : channel === 'sms' ? 'sms_gateway' : 'smtp';
  }

  private asSystem<T>(work: () => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, work);
  }
}

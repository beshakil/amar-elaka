import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { TenantContext } from '../database/tenant-context';
import { JOB_NOTIFY, QUEUE_NOTIFICATIONS } from '../queue/queue.types';
import type { OutgoingNotification } from './notification-channel';

/**
 * The one way to notify a user (ADR 059). It never delivers: it puts the
 * notification on the `notifications` queue and returns, so no request
 * waits on FCM, an SMS gateway or SMTP, and every send is retried with
 * backoff. The worker (NotificationDispatcher) then writes the inbox row,
 * collapses, checks preferences, caps and quiet hours, and sends one
 * `deliver-notification` job per channel.
 *
 * A dedupe key is also the job id while the job is queued, so a caller that
 * retries doesn't queue it twice; the inbox's unique (user, dedupe key)
 * keeps it to one notification after that.
 */
@Injectable()
export class NotificationService {
  constructor(
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly queue: Queue<OutgoingNotification>,
    private readonly context: TenantContext,
  ) {}

  /**
   * `tenantId` defaults to the tenant the caller runs in (a moderator's
   * decision, a store's staff invite): its quiet hours and timezone apply,
   * and it pays for an SMS. Background jobs pass it explicitly.
   */
  async send(notification: OutgoingNotification): Promise<{ queued: true }> {
    const tenantId = notification.tenantId ?? this.context.current()?.tenantId ?? null;
    await this.queue.add(
      JOB_NOTIFY,
      { ...notification, tenantId },
      {
        ...(notification.dedupeKey
          ? { jobId: jobIdFor(notification.userId, notification.dedupeKey) }
          : {}),
      },
    );
    return { queued: true };
  }
}

/** BullMQ rejects ':' in job ids, and keys can be long: a digest of user + key. */
function jobIdFor(userId: string, dedupeKey: string): string {
  return `notify-${createHash('sha256').update(`${userId}\n${dedupeKey}`).digest('hex')}`;
}

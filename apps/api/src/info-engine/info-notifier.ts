import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';

/** Where info engine notifications open in the apps. */
export const INFO_DEEP_LINKS = {
  notice: (id: string) => `/info/notices/${id}`,
  lostFound: (id: string) => `/info/lost-found/${id}`,
} as const;

/**
 * Info engine notices (ADR 065), as BloodNotifier: the decision or the lead
 * is committed first; a queueing failure is logged, never thrown.
 */
@Injectable()
export class InfoNotifier {
  private readonly logger = new Logger(InfoNotifier.name);

  constructor(private readonly notifications: NotificationService) {}

  /** The author hears the moderator's decision (with the reason when refused). */
  async decided(
    author: { userId: string; tenantId: string; title: string },
    kind: 'notice' | 'lost_found',
    id: string,
    decision: 'approve' | 'reject' | 'remove',
    reason: string | null,
  ): Promise<void> {
    await this.safely(`info_item_decided:${id}`, () =>
      this.notifications.send({
        userId: author.userId,
        type: 'info_item_decided',
        tenantId: author.tenantId,
        params: {
          title: author.title,
          approved: decision === 'approve' ? 'yes' : null,
          reason: decision === 'approve' ? null : reason,
        },
        deepLink: kind === 'notice' ? INFO_DEEP_LINKS.notice(id) : INFO_DEEP_LINKS.lostFound(id),
        entityId: id,
        dedupeKey: `info_item_decided:${id}:${decision}`,
      }),
    );
  }

  /** A lost & found reporter hears that someone took their number. */
  async lostFoundContacted(
    reporter: { userId: string; tenantId: string; title: string },
    id: string,
    leadKey: string,
  ): Promise<void> {
    await this.safely(`lost_found_contacted:${id}`, () =>
      this.notifications.send({
        userId: reporter.userId,
        type: 'lost_found_contacted',
        tenantId: reporter.tenantId,
        params: { title: reporter.title },
        deepLink: INFO_DEEP_LINKS.lostFound(id),
        entityId: id,
        dedupeKey: `lost_found_contacted:${id}:${leadKey}`,
      }),
    );
  }

  private async safely(what: string, send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.warn(`could not queue ${what}: ${String(error)}`);
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { NotificationService } from '../notifications/notification.service';
import type { ParticipantRow } from './chat.repository';
import { CHAT_STORE, type ChatStore } from './chat.store';

/**
 * Tells the other participants about a new message through the platform's
 * notification channels (in-app today, push when week 11's channel lands —
 * NotificationService is the one sender). Someone viewing the conversation
 * right now (presence, chat.store.ts) gets nothing: the socket already
 * showed it.
 *
 * One notification per unread streak, not per message: the dedupe key is
 * the conversation plus the recipient's read watermark, and messages inside
 * the collapse window fold into one ("৪টি নতুন মেসেজ", ADR 059) across
 * conversations. Names the sender (the store, for its staff); never the
 * message text (lock screens), never a phone number.
 */
@Injectable()
export class ChatNotifier {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(CHAT_STORE) private readonly store: ChatStore,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChatNotifier.name);
  }

  /** Fire and forget, after the message committed: a notification failure never fails a send. */
  newMessage(event: {
    tenantId: string;
    conversationId: string;
    senderName: string | null;
    senderUserId: string;
    recipients: readonly ParticipantRow[];
  }): void {
    void this.deliver(event).catch((error: unknown) =>
      this.logger.error(
        { err: error, conversationId: event.conversationId },
        'chat notification failed',
      ),
    );
  }

  private async deliver(event: {
    tenantId: string;
    conversationId: string;
    senderName: string | null;
    senderUserId: string;
    recipients: readonly ParticipantRow[];
  }): Promise<void> {
    const others = event.recipients.filter((r) => r.user_id !== event.senderUserId);
    const viewing = await this.store.viewers(
      event.conversationId,
      others.map((r) => r.user_id),
    );
    await Promise.all(
      others
        .filter((r) => !viewing.has(r.user_id))
        .map((r) =>
          this.notifications.send({
            userId: r.user_id,
            type: 'new_message',
            tenantId: event.tenantId,
            params: {
              conversationId: event.conversationId,
              tenantId: event.tenantId,
              senderName: event.senderName,
            },
            deepLink: `/chat/${event.conversationId}`,
            entityId: event.conversationId,
            dedupeKey: `chat:${event.conversationId}:${r.last_read_message_id ?? 'none'}`,
            // Several messages, any conversation, become one: "৪টি নতুন মেসেজ" opening the inbox.
            collapse: { key: 'new_message', deepLink: '/chat' },
          }),
        ),
    );
  }
}

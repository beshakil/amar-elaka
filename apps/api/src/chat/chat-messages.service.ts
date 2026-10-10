import { Inject, Injectable } from '@nestjs/common';
import { AnalyticsTracker } from '../analytics/seller/analytics-tracker.service';
import { sqlStateOf } from '../common/utils/sql-state';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantDb } from '../database/tenant-db';
import { EngagementRepository } from '../engagement/engagement.repository';
import { viewerKey } from '../engagement/viewer-key';
import { FeedService } from '../feed/feed.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import { ChatNotifier } from './chat-notifier';
import { ChatScope } from './chat-scope';
import { ChatViews } from './chat-views';
import {
  ChatBlockedException,
  ChatContactInfoBlockedException,
  ChatImageInvalidException,
  ChatListingUnavailableException,
  ChatLockedException,
  ChatMessageTooLongException,
  ChatRateLimitedException,
  ConversationNotFoundException,
} from './chat.exceptions';
import {
  ChatRepository,
  SELLER_SIDE,
  type LeadClaim,
  type MessageRow,
  type NewMessage,
  type ParticipantRow,
} from './chat.repository';
import { CHAT_STORE, type ChatStore } from './chat.store';
import { checkContactInfo } from './contact-filter';
import type { ListingSnapshot, MessageContent, SendMessageInput, SendResult } from './dto/chat.dto';
import { ChatBroadcaster, SERVER_EVENTS } from './realtime/chat-broadcaster';

// settings-exempt: "per minute" is a rolling 60 seconds (the limit itself is a setting)
const SECONDS_PER_MINUTE = 60;
// RLS refused the insert (messages_sender_insert): a lock or block landed between our check and it.
const INSUFFICIENT_PRIVILEGE = '42501';

interface Sent {
  row: MessageRow;
  created: boolean;
  participants: ParticipantRow[];
  lead: LeadClaim | undefined;
  /** How the recipients' notification names the sender: the store for its staff, else the person. */
  senderName: string | null;
}

/**
 * Sending a message (ADR 058) — the one path for the socket and for REST:
 *
 *   1. per-user rate limit (chat_messages_per_user_per_minute, Redis: every
 *      instance shares the count);
 *   2. a resend of a clientMessageId already stored returns that message and
 *      sends nothing out again — the client's offline queue replays freely;
 *   3. locked / blocked → typed refusal (RLS refuses anyway);
 *   4. the contact check: a phone number or link within the conversation's
 *      first chat_contact_filter_first_messages messages (per tenant) is
 *      held back with CHAT_CONTACT_INFO_BLOCKED; later ones go through,
 *      flagged for moderation;
 *   5. insert as the caller (RLS: participant, not locked, not blocked);
 *   6. the first seller-side reply writes the chat lead — lead_events
 *      channel chat_started, through the same insertLead as every contact
 *      reveal — in the same transaction;
 *   7. after commit: fan-out to every participant's user room (all their
 *      devices, any instance), notification for those not viewing it.
 */
@Injectable()
export class ChatMessagesService {
  private readonly secret: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly scope: ChatScope,
    private readonly ownership: PostOwnershipService,
    private readonly repo: ChatRepository,
    private readonly leads: EngagementRepository,
    private readonly feed: FeedService,
    private readonly views: ChatViews,
    private readonly settings: SettingsService,
    private readonly broadcaster: ChatBroadcaster,
    private readonly notifier: ChatNotifier,
    private readonly tracker: AnalyticsTracker,
    @Inject(CHAT_STORE) private readonly store: ChatStore,
    @Inject(APP_CONFIG) env: Pick<Env, 'JWT_SECRET'>,
  ) {
    this.secret = env.JWT_SECRET;
  }

  send(conversationId: string, input: SendMessageInput): Promise<SendResult> {
    const userId = this.scope.requireUserId();
    return this.scope.inConversation(conversationId, async ({ tenantId }) => {
      const [perMinute, maxLength, firstMessages, urlTtl] = await Promise.all([
        this.settings.get('chat_messages_per_user_per_minute', tenantId),
        this.settings.get('chat_message_max_length', tenantId),
        this.settings.get('chat_contact_filter_first_messages', tenantId),
        this.settings.get('chat_media_url_ttl_seconds', tenantId),
      ]);
      const rate = `send:${userId}`;
      if ((await this.store.count(rate, SECONDS_PER_MINUTE)) > perMinute) {
        await this.store.uncount(rate);
        throw new ChatRateLimitedException(perMinute, 'minute');
      }

      let sent: Sent;
      try {
        // A listing card reads the post in its own tenant: before our transaction.
        const listing =
          input.content.kind === 'listing_card'
            ? await this.listingSnapshot(input.content.postId)
            : null;
        sent = await this.tenantDb.transaction((tx) =>
          this.persist(tx, conversationId, input, { maxLength, firstMessages, listing }),
        );
      } catch (error) {
        await this.store.uncount(rate);
        if (sqlStateOf(error) === INSUFFICIENT_PRIVILEGE) throw new ChatBlockedException();
        throw error;
      }
      // A resend sent nothing: it costs nothing either.
      if (!sent.created) await this.store.uncount(rate);

      const message = await this.views.message(sent.row, urlTtl);
      if (sent.created) {
        this.broadcaster.toUsers(
          sent.participants.map((p) => p.user_id),
          SERVER_EVENTS.messageNew,
          { conversationId, tenantId, message },
        );
        this.notifier.newMessage({
          tenantId,
          conversationId,
          senderName: sent.senderName,
          senderUserId: userId,
          recipients: sent.participants,
        });
        if (sent.lead) this.trackLead(tenantId, sent.lead);
      }
      return { message, created: sent.created };
    });
  }

  private async persist(
    tx: DatabaseTransaction,
    conversationId: string,
    input: SendMessageInput,
    rules: { maxLength: number; firstMessages: number; listing: ListingSnapshot | null },
  ): Promise<Sent> {
    const existing = await this.repo.findSent(tx, conversationId, input.clientMessageId);
    if (existing)
      return { row: existing, created: false, participants: [], lead: undefined, senderName: null };

    const [state] = await this.repo.myConversations(tx, { conversationId, limit: 1 });
    if (!state) throw new ConversationNotFoundException();
    if (state.is_locked) throw new ChatLockedException();
    if (state.blocked) throw new ChatBlockedException();

    const message = await this.newMessage(tx, conversationId, input, rules);
    const id = await this.repo.insertMessage(tx, message);
    if (!id) {
      // The same clientMessageId won a race with us (two sockets replaying one queue).
      const raced = await this.repo.findSent(tx, conversationId, input.clientMessageId);
      if (!raced) throw new ConversationNotFoundException();
      return { row: raced, created: false, participants: [], lead: undefined, senderName: null };
    }
    const [row] = await this.repo.messagesByIds(tx, [id]);
    const participants = await this.repo.participants(tx, conversationId);
    const lead = SELLER_SIDE.has(state.my_role_code)
      ? await this.repo.claimFirstSellerReply(tx, conversationId, id)
      : undefined;
    if (lead) {
      await this.leads.insertLead(tx, {
        channel: 'chat_started',
        source: lead.source_code,
        postId: lead.post_id,
        storeId: lead.store_id,
        targetMemberId: lead.seller_member_id ?? state.my_member_id,
        actorMemberId: lead.buyer_member_id,
        viewerKey: this.buyerKey(lead),
      });
    }
    const senderName =
      state.my_role_code !== 'buyer' && state.store_name_bn
        ? state.store_name_bn
        : await this.repo.displayName(tx, this.scope.requireUserId());
    return { row: row!, created: true, participants, lead, senderName };
  }

  private async newMessage(
    tx: DatabaseTransaction,
    conversationId: string,
    input: SendMessageInput,
    rules: { maxLength: number; firstMessages: number; listing: ListingSnapshot | null },
  ): Promise<NewMessage> {
    const base = {
      conversationId,
      clientMessageId: input.clientMessageId,
      body: null,
      mediaAssetId: null,
      lat: null,
      lng: null,
      listingSnapshot: null,
      flaggedByFilter: false,
    };
    const content: MessageContent = input.content;
    switch (content.kind) {
      case 'text': {
        if ([...content.body].length > rules.maxLength) {
          throw new ChatMessageTooLongException(rules.maxLength);
        }
        const check = checkContactInfo(
          content.body,
          await this.repo.countMessages(tx, conversationId),
          rules.firstMessages,
        );
        if (check.outcome === 'blocked') {
          throw new ChatContactInfoBlockedException(check.found, check.remaining);
        }
        return {
          ...base,
          kind: 'text',
          body: content.body,
          flaggedByFilter: check.outcome === 'flagged',
        };
      }
      case 'image':
        if (!(await this.repo.isUsableChatImage(tx, content.mediaId)))
          throw new ChatImageInvalidException();
        return { ...base, kind: 'image', mediaAssetId: content.mediaId };
      case 'location':
        return { ...base, kind: 'location', lat: content.lat, lng: content.lng };
      case 'listing_card':
        return { ...base, kind: 'listing_card', listingSnapshot: rules.listing };
    }
  }

  /**
   * The card a post is shared as: built here from the feed's own post card
   * (read in the post's tenant as a visitor would see it), never taken from
   * the client — title, price, cover, nothing else (no seller, no phone).
   * A post the feed wouldn't show can't be shared. A later scrub replaces
   * the snapshot with the neutral marker everywhere (posts_scrub_listing_cards).
   */
  private async listingSnapshot(postId: string): Promise<ListingSnapshot> {
    const tenantId = await this.ownership.tenantOf(postId);
    if (!tenantId) throw new ChatListingUnavailableException();
    const [card] = await this.feed.cardsFor([{ id: postId, tenant_id: tenantId }]);
    if (!card) throw new ChatListingUnavailableException();
    return {
      state: 'shared',
      postId: card.id,
      tenantId: card.tenantId,
      title: card.title,
      price: card.price,
      cover: card.cover,
    };
  }

  /** The buyer as a lead's viewer: the same key a signed-in contact reveal gets. */
  private buyerKey(lead: LeadClaim): string {
    return viewerKey(this.secret, {
      userId: lead.buyer_user_id,
      installId: undefined,
      ip: '',
      userAgent: undefined,
    });
  }

  private trackLead(tenantId: string, lead: LeadClaim): void {
    this.tracker.contact({
      tenantId,
      postId: lead.post_id,
      storeId: lead.store_id,
      authorMemberId: lead.seller_member_id,
      channel: 'chat',
      visitor: this.buyerKey(lead),
    });
  }
}

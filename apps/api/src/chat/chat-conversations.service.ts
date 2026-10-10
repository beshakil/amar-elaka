import { Inject, Injectable } from '@nestjs/common';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantDb } from '../database/tenant-db';
import { FeedService } from '../feed/feed.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import { ChatScope } from './chat-scope';
import { ChatViews } from './chat-views';
import {
  ChatBlockedException,
  ChatMessageNotFoundException,
  ChatOwnListingException,
  ChatRateLimitedException,
  ChatReportDetailsTooLongException,
  ChatTargetUnavailableException,
  ConversationNotFoundException,
} from './chat.exceptions';
import {
  ChatRepository,
  SELLER_SIDE,
  type ConversationRow,
  type ParticipantRow,
} from './chat.repository';
import { CHAT_STORE, type ChatStore } from './chat.store';
import type {
  ConversationView,
  HistoryPage,
  HistoryQuery,
  InboxPage,
  InboxQuery,
  OpenConversationInput,
  OpenConversationResult,
  ReceiptResult,
  ReportConversationInput,
  ReportResult,
} from './dto/chat.dto';
import { ChatBroadcaster, SERVER_EVENTS } from './realtime/chat-broadcaster';

// settings-exempt: "per day" is a rolling 24 hours (the limits themselves are settings)
const SECONDS_PER_DAY = 24 * 60 * 60;
const NO_DATA_FOUND = 'P0002';
const OWN_LISTING = 'AE260';
const BLOCKED = 'AE261';

/**
 * Conversations (ADR 058): open or reopen one, the inbox across every
 * tenant, history, delivery/read receipts, block and report. Sending is
 * ChatMessagesService's. Every conversation-scoped call goes through
 * ChatScope (the conversation's tenant, the caller's membership, RLS).
 */
@Injectable()
export class ChatConversationsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly scope: ChatScope,
    private readonly ownership: PostOwnershipService,
    private readonly repo: ChatRepository,
    private readonly views: ChatViews,
    private readonly settings: SettingsService,
    private readonly broadcaster: ChatBroadcaster,
    private readonly feed: FeedService,
    @Inject(CHAT_STORE) private readonly store: ChatStore,
  ) {}

  /** POST /posts/:id/conversations — the buyer's conversation about a post, in the post's tenant. */
  async openForPost(postId: string, input: OpenConversationInput): Promise<OpenConversationResult> {
    const tenantId = await this.ownership.tenantOf(postId);
    if (!tenantId) throw new ChatTargetUnavailableException();
    return this.open(tenantId, { postId, storeId: null }, input.source);
  }

  /** POST /stores/:id/conversations — the buyer's conversation with a store. */
  async openForStore(
    storeId: string,
    input: OpenConversationInput,
  ): Promise<OpenConversationResult> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.storeTenantOf(tx, storeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new ChatTargetUnavailableException();
    return this.open(tenantId, { postId: null, storeId }, input.source);
  }

  async inbox(query: InboxQuery): Promise<InboxPage> {
    this.scope.requireUserId();
    const max = await this.settings.get('chat_inbox_page_size_max');
    const limit = Math.min(query.limit ?? max, max);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.tenantDb.transaction(
      (tx) =>
        this.repo.myConversations(tx, {
          ...(cursor ? { beforeAt: cursor.at, beforeId: cursor.id } : {}),
          limit: limit + 1,
          archived: query.archived ?? false,
        }),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    const [last, cards] = await Promise.all([this.lastMessages(page), this.postCards(page)]);
    const tail = page[page.length - 1];
    return {
      items: page.map((row) =>
        this.views.conversation(
          row,
          last.get(row.conversation_id) ?? null,
          row.post_id ? cards.get(row.post_id) : undefined,
        ),
      ),
      nextCursor:
        rows.length > limit && tail ? encodeCursor(tail.activity_at, tail.conversation_id) : null,
    };
  }

  get(conversationId: string): Promise<ConversationView> {
    return this.scope.inConversation(conversationId, ({ tenantId }) =>
      this.viewOf(conversationId, tenantId),
    );
  }

  history(conversationId: string, query: HistoryQuery): Promise<HistoryPage> {
    return this.scope.inConversation(conversationId, async ({ tenantId }) => {
      const max = await this.settings.get('chat_history_page_size_max', tenantId);
      const limit = Math.min(query.limit ?? max, max);
      const rows = await this.tenantDb.transaction(
        (tx) =>
          this.repo.history(tx, conversationId, {
            ...(query.before ? { before: query.before } : {}),
            ...(query.after ? { after: query.after } : {}),
            limit: limit + 1,
          }),
        { accessMode: 'read only' },
      );
      return {
        items: await this.views.messages(rows.slice(0, limit), tenantId),
        hasMore: rows.length > limit,
      };
    });
  }

  /**
   * Moves the caller's delivered or read watermark (one row, whatever the
   * number of messages) and tells the participants, so senders see ✓✓.
   */
  receipt(
    conversationId: string,
    upToMessageId: string,
    kind: 'delivered' | 'read',
  ): Promise<ReceiptResult> {
    return this.scope.inConversation(conversationId, async ({ memberId }) => {
      const { moved, participants } = await this.tenantDb.transaction(async (tx) => ({
        moved: await this.repo.moveWatermark(tx, conversationId, upToMessageId, kind),
        participants: await this.repo.participants(tx, conversationId),
      }));
      if (!moved) throw new ChatMessageNotFoundException();
      const result: ReceiptResult = { conversationId, memberId, ...moved };
      this.broadcaster.toUsers(
        participants.map((p) => p.user_id),
        SERVER_EVENTS.receipt,
        { conversationId, memberId, deliveredUpTo: moved.deliveredUpTo, readUpTo: moved.readUpTo },
      );
      return result;
    });
  }

  /**
   * Blocks the other side (user_blocks: every tenant, every conversation
   * between them). A buyer blocks the whole seller side — the seller and the
   * store's staff — so a store can't keep writing through someone else; a
   * seller-side member blocks the buyer for themselves. RLS then refuses
   * messages both ways (0009); typing stops at once because everyone's
   * sockets leave the conversation room.
   */
  block(conversationId: string): Promise<ConversationView> {
    return this.changeBlock(conversationId, 'block');
  }

  unblock(conversationId: string): Promise<ConversationView> {
    return this.changeBlock(conversationId, 'unblock');
  }

  /**
   * Reports the conversation to the tenant's moderators with its transcript
   * attached as evidence (report_conversation, 0054). Reporting again
   * returns the open report and uses none of the daily quota.
   */
  async report(conversationId: string, input: ReportConversationInput): Promise<ReportResult> {
    const userId = this.scope.requireUserId();
    return this.scope.inConversation(conversationId, async ({ tenantId }) => {
      const [detailsMax, perDay, transcriptMax] = await Promise.all([
        this.settings.get('report_details_max_length', tenantId),
        this.settings.get('reports_per_user_per_day', tenantId),
        this.settings.get('chat_report_transcript_max_messages', tenantId),
      ]);
      const text = input.text && input.text.length > 0 ? input.text : null;
      if (text !== null && [...text].length > detailsMax) {
        throw new ChatReportDetailsTooLongException(detailsMax);
      }
      const rate = `report:${userId}`;
      if ((await this.store.count(rate, SECONDS_PER_DAY)) > perDay) {
        await this.store.uncount(rate);
        throw new ChatRateLimitedException(perDay, 'day');
      }
      try {
        const result = await this.tenantDb.transaction((tx) =>
          this.repo.reportConversation(tx, conversationId, input.reasonCode, text, transcriptMax),
        );
        if (!result.created) await this.store.uncount(rate);
        return result;
      } catch (error) {
        await this.store.uncount(rate);
        if (sqlStateOf(error) === NO_DATA_FOUND) throw new ConversationNotFoundException();
        throw error;
      }
    });
  }

  /** The conversation as the caller sees it, in its tenant's context (ChatScope). */
  async viewOf(conversationId: string, tenantId: string): Promise<ConversationView> {
    const { row, last } = await this.tenantDb.transaction(
      async (tx) => {
        const [found] = await this.repo.myConversations(tx, { conversationId, limit: 1 });
        const lastRows = found?.last_message_id
          ? await this.repo.messagesByIds(tx, [found.last_message_id])
          : [];
        return { row: found, last: lastRows };
      },
      { accessMode: 'read only' },
    );
    if (!row) throw new ConversationNotFoundException();
    const [[lastMessage], cards] = await Promise.all([
      this.views.messages(last, tenantId),
      this.postCards([row]),
    ]);
    return this.views.conversation(
      row,
      lastMessage ?? null,
      row.post_id ? cards.get(row.post_id) : undefined,
    );
  }

  private async open(
    tenantId: string,
    target: { postId: string | null; storeId: string | null },
    source: string,
  ): Promise<OpenConversationResult> {
    const userId = this.scope.requireUserId();
    const perDay = await this.settings.get('chat_new_conversations_per_user_per_day', tenantId);
    const rate = `open:${userId}`;
    if ((await this.store.count(rate, SECONDS_PER_DAY)) > perDay) {
      await this.store.uncount(rate);
      throw new ChatRateLimitedException(perDay, 'day');
    }
    try {
      return await this.scope.asMemberOf(tenantId, async () => {
        const opened = await this.tenantDb.transaction((tx) =>
          this.repo.openConversation(tx, target, source),
        );
        // Reopening is free: only a new conversation uses the daily quota.
        if (!opened.created) await this.store.uncount(rate);
        return {
          conversation: await this.viewOf(opened.conversationId, tenantId),
          created: opened.created,
        };
      });
    } catch (error) {
      await this.store.uncount(rate);
      const state = sqlStateOf(error);
      if (state === NO_DATA_FOUND) throw new ChatTargetUnavailableException();
      if (state === OWN_LISTING) throw new ChatOwnListingException();
      if (state === BLOCKED) throw new ChatBlockedException();
      throw error;
    }
  }

  private changeBlock(
    conversationId: string,
    change: 'block' | 'unblock',
  ): Promise<ConversationView> {
    return this.scope.inConversation(conversationId, async ({ tenantId, memberId }) => {
      const participants = await this.tenantDb.transaction(async (tx) => {
        const all = await this.repo.participants(tx, conversationId);
        const others = blockTargetsOf(all, memberId);
        if (others.length === 0) throw new ConversationNotFoundException();
        for (const other of others) {
          if (change === 'block') await this.repo.block(tx, other.user_id);
          else await this.repo.unblock(tx, other.user_id);
        }
        return all;
      });
      const users = participants.map((p) => p.user_id);
      if (change === 'block') this.broadcaster.leaveConversation(users, conversationId);
      this.broadcaster.toUsers(users, SERVER_EVENTS.conversationUpdated, { conversationId });
      return this.viewOf(conversationId, tenantId);
    });
  }

  /** Archive it (out of the inbox, back on the next message) or bring it back, for the caller only. */
  setArchived(conversationId: string, archived: boolean): Promise<ConversationView> {
    return this.scope.inConversation(conversationId, async ({ tenantId }) => {
      const changed = await this.tenantDb.transaction((tx) =>
        this.repo.setArchived(tx, conversationId, archived),
      );
      if (!changed) throw new ConversationNotFoundException();
      return this.viewOf(conversationId, tenantId);
    });
  }

  /**
   * The cover and price of each conversation's post, from the feed's own
   * post card (read in the post's tenant as a visitor sees it): a post that
   * isn't listed any more has no card, and the conversation shows its title only.
   */
  private async postCards(
    rows: readonly ConversationRow[],
  ): Promise<
    Map<string, { price: string | null; cover: { url: string; thumbhash: string | null } | null }>
  > {
    const refs = rows
      .filter((r) => r.post_id !== null && r.post_title !== null)
      .map((r) => ({ id: r.post_id!, tenant_id: r.tenant_id }));
    if (refs.length === 0) return new Map();
    const cards = await this.feed.cardsFor(refs);
    return new Map(cards.map((c) => [c.id, { price: c.price, cover: c.cover }]));
  }

  /** Each conversation's last message, read in that conversation's own tenant. */
  private async lastMessages(
    rows: readonly ConversationRow[],
  ): Promise<Map<string, ConversationView['lastMessage']>> {
    const byTenant = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.last_message_id) continue;
      byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row.last_message_id]);
    }
    const result = new Map<string, ConversationView['lastMessage']>();
    for (const [tenantId, ids] of byTenant) {
      const messages = await this.scope.lookupIn(tenantId, async () =>
        this.views.messages(
          await this.tenantDb.transaction((tx) => this.repo.messagesByIds(tx, ids), {
            accessMode: 'read only',
          }),
          tenantId,
        ),
      );
      for (const message of messages) result.set(message.conversationId, message);
    }
    return result;
  }
}

/** Whom a block by `memberId` covers: the whole seller side for the buyer, the buyer otherwise. */
export function blockTargetsOf(
  participants: readonly ParticipantRow[],
  memberId: string,
): ParticipantRow[] {
  const me = participants.find((p) => p.member_id === memberId);
  if (!me) return [];
  const targets =
    me.role_code === 'buyer'
      ? participants.filter((p) => SELLER_SIDE.has(p.role_code))
      : participants.filter((p) => p.role_code === 'buyer');
  // Never yourself: user_blocks refuses a self-block, and a user may hold two memberships.
  return targets.filter((p) => p.user_id !== me.user_id);
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { at?: unknown }).at === 'string' &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      !Number.isNaN(Date.parse((parsed as { at: string }).at)) &&
      /^[0-9a-f-]{36}$/i.test((parsed as { id: string }).id)
    ) {
      return parsed as { at: string; id: string };
    }
  } catch {
    // fall through: a bad cursor reads as the first page
  }
  return undefined;
}

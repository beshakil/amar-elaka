import { Injectable } from '@nestjs/common';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { ChatScope } from './chat-scope';
import {
  ChatTargetUnavailableException,
  ConversationNotFoundException,
  QuickRepliesForbiddenException,
  QuickReplyLimitReachedException,
  QuickReplyNotFoundException,
  QuickReplyTooLongException,
} from './chat.exceptions';
import { ChatRepository, SELLER_SIDE, type QuickReplyRow } from './chat.repository';
import type { QuickReplyInput, QuickReplyList, QuickReplyView } from './dto/chat.dto';

/**
 * A store's quick replies (ADR 058): canned answers its owner and managers
 * insert from the composer. At most chat_quick_replies_per_store_max, each
 * at most chat_quick_reply_max_length characters; writes are serialised per
 * store so the count can't be raced past. Read and written in the store's
 * own tenant under can_manage_store (RLS, 0054).
 */
@Injectable()
export class QuickRepliesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly scope: ChatScope,
    private readonly repo: ChatRepository,
    private readonly settings: SettingsService,
  ) {}

  list(storeId: string): Promise<QuickReplyList> {
    return this.asManager(storeId, async (tenantId) => this.listIn(storeId, tenantId));
  }

  /** The composer's list in a store conversation, for the seller side only. */
  forConversation(conversationId: string): Promise<QuickReplyList> {
    return this.scope.inConversation(conversationId, async ({ tenantId }) => {
      const [state] = await this.tenantDb.transaction(
        (tx) => this.repo.myConversations(tx, { conversationId, limit: 1 }),
        { accessMode: 'read only' },
      );
      if (!state) throw new ConversationNotFoundException();
      if (!state.store_id || !SELLER_SIDE.has(state.my_role_code)) {
        return { items: [], ...(await this.limits(tenantId)) };
      }
      const allowed = await this.tenantDb.transaction(
        (tx) => this.repo.canManageStore(tx, state.store_id!),
        {
          accessMode: 'read only',
        },
      );
      if (!allowed) return { items: [], ...(await this.limits(tenantId)) };
      return this.listIn(state.store_id, tenantId);
    });
  }

  create(storeId: string, input: QuickReplyInput): Promise<QuickReplyView> {
    return this.asManager(storeId, async (tenantId) => {
      const { max, maxLength } = await this.limits(tenantId);
      if ([...input.body].length > maxLength) throw new QuickReplyTooLongException(maxLength);
      const row = await this.tenantDb.transaction(async (tx) => {
        await this.repo.lockStoreQuickReplies(tx, storeId);
        const existing = await this.repo.quickReplies(tx, storeId);
        if (existing.length >= max) throw new QuickReplyLimitReachedException(max);
        return this.repo.insertQuickReply(
          tx,
          storeId,
          input.body,
          input.sortOrder ?? existing.length,
        );
      });
      return toView(row);
    });
  }

  update(storeId: string, replyId: string, input: QuickReplyInput): Promise<QuickReplyView> {
    return this.asManager(storeId, async (tenantId) => {
      const { maxLength } = await this.limits(tenantId);
      if ([...input.body].length > maxLength) throw new QuickReplyTooLongException(maxLength);
      const row = await this.tenantDb.transaction((tx) =>
        this.repo.updateQuickReply(tx, storeId, replyId, input.body, input.sortOrder),
      );
      if (!row) throw new QuickReplyNotFoundException();
      return toView(row);
    });
  }

  remove(storeId: string, replyId: string): Promise<void> {
    return this.asManager(storeId, async () => {
      const removed = await this.tenantDb.transaction((tx) =>
        this.repo.deleteQuickReply(tx, storeId, replyId),
      );
      if (!removed) throw new QuickReplyNotFoundException();
    });
  }

  private async listIn(storeId: string, tenantId: string): Promise<QuickReplyList> {
    const rows = await this.tenantDb.transaction((tx) => this.repo.quickReplies(tx, storeId), {
      accessMode: 'read only',
    });
    return { items: rows.map(toView), ...(await this.limits(tenantId)) };
  }

  private async limits(tenantId: string): Promise<{ max: number; maxLength: number }> {
    const [max, maxLength] = await Promise.all([
      this.settings.get('chat_quick_replies_per_store_max', tenantId),
      this.settings.get('chat_quick_reply_max_length', tenantId),
    ]);
    return { max, maxLength };
  }

  /** In the store's tenant, as its owner or an accepted manager; anyone else is refused. */
  private async asManager<T>(storeId: string, work: (tenantId: string) => Promise<T>): Promise<T> {
    this.scope.requireUserId();
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.storeTenantOf(tx, storeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new ChatTargetUnavailableException();
    return this.scope.lookupIn(tenantId, async (memberId) => {
      if (!memberId) throw new QuickRepliesForbiddenException();
      const allowed = await this.tenantDb.transaction(
        (tx) => this.repo.canManageStore(tx, storeId),
        {
          accessMode: 'read only',
        },
      );
      if (!allowed) throw new QuickRepliesForbiddenException();
      return work(tenantId);
    });
  }
}

function toView(row: QuickReplyRow): QuickReplyView {
  return { id: row.id, body: row.body, sortOrder: row.sort_order };
}

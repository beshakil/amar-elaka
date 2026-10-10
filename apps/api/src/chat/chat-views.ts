import { Inject, Injectable } from '@nestjs/common';
import { parseVariants, variantKeys } from '../media/media.types';
import { SettingsService } from '../settings/settings.service';
import { MEDIA_KIND_POLICIES } from '../storage/media-kind.constants';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type { ConversationRow, MessageRow } from './chat.repository';
import { listingSnapshotSchema, type ConversationView, type MessageView } from './dto/chat.dto';

/**
 * Rows → what the API sends (REST and socket alike). Nothing here can carry
 * a phone number: a conversation names its counterpart by display name or
 * store name only, and a listing card is the snapshot the server built
 * (title, price, cover — chat-messages.service.ts).
 */
@Injectable()
export class ChatViews {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  async messages(rows: readonly MessageRow[], tenantId: string): Promise<MessageView[]> {
    const ttl = rows.some((r) => r.media_asset_id !== null)
      ? await this.settings.get('chat_media_url_ttl_seconds', tenantId)
      : 0;
    return Promise.all(rows.map((row) => this.message(row, ttl)));
  }

  async message(row: MessageRow, urlTtlSeconds: number): Promise<MessageView> {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      clientMessageId: row.client_message_id,
      senderMemberId: row.sender_member_id,
      senderRole: row.sender_role,
      kind: row.kind_code === 'offer' ? 'text' : row.kind_code,
      body: row.body,
      image: await this.image(row, urlTtlSeconds),
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      listing: this.listing(row.listing_snapshot),
      systemEvent: row.system_event_key,
      createdAt: row.created_at,
    };
  }

  conversation(
    row: ConversationRow,
    lastMessage: MessageView | null,
    card?: { price: string | null; cover: { url: string; thumbhash: string | null } | null },
  ): ConversationView {
    const postVisible = row.post_id !== null && row.post_title !== null;
    return {
      id: row.conversation_id,
      tenantId: row.tenant_id,
      kind: row.kind_code,
      post: postVisible
        ? {
            id: row.post_id!,
            title: row.post_title!,
            price: card?.price ?? null,
            cover: card?.cover ?? null,
          }
        : null,
      postRemoved: row.post_context_removed,
      store:
        row.store_id !== null && row.store_slug !== null && row.store_name_bn !== null
          ? {
              id: row.store_id,
              slug: row.store_slug,
              name: { bn: row.store_name_bn, en: row.store_name_en },
            }
          : null,
      counterpart: { kind: row.counterpart_kind, name: row.counterpart_name },
      me: { memberId: row.my_member_id, role: row.my_role_code },
      unreadCount: row.unread_count,
      isArchived: row.is_archived,
      isLocked: row.is_locked,
      isBlocked: row.blocked,
      blockedByMe: row.blocked_by_me,
      canSend: !row.is_locked && !row.blocked,
      othersDeliveredUpTo: row.others_delivered_up_to,
      othersReadUpTo: row.others_read_up_to,
      myReadUpTo: row.my_last_read_message_id,
      lastMessage,
      activityAt: row.activity_at,
    };
  }

  private async image(row: MessageRow, ttl: number): Promise<MessageView['image']> {
    if (row.media_asset_id === null) return null;
    const variants = parseVariants(row.media_variants);
    if (!variants) return null;
    const bucket = MEDIA_KIND_POLICIES.chat_image.bucket;
    const signed = await Promise.all(
      variantKeys.map(
        async (name) =>
          [
            name,
            {
              url: await this.storage.presignDownload(bucket, variants[name].key, ttl),
              width: variants[name].width,
              height: variants[name].height,
            },
          ] as const,
      ),
    );
    const byName = Object.fromEntries(signed) as Record<
      (typeof variantKeys)[number],
      { url: string; width: number; height: number }
    >;
    return {
      thumb: byName.thumb,
      card: byName.card,
      full: byName.full,
      thumbhash: row.media_thumbhash,
    };
  }

  private listing(value: unknown): MessageView['listing'] {
    if (value === null || value === undefined) return null;
    const parsed = listingSnapshotSchema.safeParse(value);
    // Anything unrecognised is shown as removed, never passed through raw.
    return parsed.success ? parsed.data : { state: 'listing_removed' };
  }
}

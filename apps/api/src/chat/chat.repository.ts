import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { ListingSnapshot, ParticipantRole } from './dto/chat.dto';

/** Timestamps come back from postgres-js as Date or string depending on the path; normalise to ISO. */
const timestamp = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());

const conversationRow = z.object({
  conversation_id: z.string(),
  tenant_id: z.string(),
  kind_code: z.enum(['post_inquiry', 'store_inquiry', 'direct']),
  post_id: z.string().nullable(),
  store_id: z.string().nullable(),
  post_context_removed: z.boolean(),
  is_locked: z.boolean(),
  created_at: timestamp,
  activity_at: timestamp,
  unread_count: z.number(),
  is_archived: z.boolean(),
  my_member_id: z.string(),
  my_role_code: z.enum(['buyer', 'seller', 'store_staff']),
  my_last_read_message_id: z.string().nullable(),
  others_delivered_up_to: z.string().nullable(),
  others_read_up_to: z.string().nullable(),
  post_title: z.string().nullable(),
  store_slug: z.string().nullable(),
  store_name_bn: z.string().nullable(),
  store_name_en: z.string().nullable(),
  counterpart_kind: z.enum(['buyer', 'seller', 'store']),
  counterpart_name: z.string().nullable(),
  blocked: z.boolean(),
  blocked_by_me: z.boolean(),
  last_message_id: z.string().nullable(),
});
export type ConversationRow = z.infer<typeof conversationRow>;

const messageRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  client_message_id: z.string(),
  sender_member_id: z.string().nullable(),
  sender_role: z.enum(['buyer', 'seller', 'store_staff']).nullable(),
  kind_code: z.enum(['text', 'image', 'location', 'listing_card', 'system', 'offer']),
  body: z.string().nullable(),
  media_asset_id: z.string().nullable(),
  media_variants: z.unknown().nullable(),
  media_thumbhash: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  listing_snapshot: z.unknown().nullable(),
  system_event_key: z.string().nullable(),
  created_at: timestamp,
});
export type MessageRow = z.infer<typeof messageRow>;

const participantRow = z.object({
  member_id: z.string(),
  user_id: z.string(),
  role_code: z.enum(['buyer', 'seller', 'store_staff']),
  last_read_message_id: z.string().nullable(),
});
export type ParticipantRow = z.infer<typeof participantRow>;

const receiptRow = z.object({
  last_delivered_message_id: z.string().nullable(),
  last_read_message_id: z.string().nullable(),
  unread_count: z.number(),
});

const leadClaimRow = z.object({
  post_id: z.string().nullable(),
  store_id: z.string().nullable(),
  source_code: z.string(),
  seller_member_id: z.string().nullable(),
  buyer_member_id: z.string(),
  buyer_user_id: z.string(),
});
export type LeadClaim = z.infer<typeof leadClaimRow>;

const quickReplyRow = z.object({ id: z.string(), body: z.string(), sort_order: z.number() });
export type QuickReplyRow = z.infer<typeof quickReplyRow>;

const reportQueueRow = z.object({
  report_id: z.string(),
  conversation_id: z.string(),
  reporter_member_id: z.string(),
  reason_code: z.string(),
  details: z.string().nullable(),
  status_code: z.string(),
  message_count: z.number(),
  created_at: timestamp,
});
export type ReportQueueRow = z.infer<typeof reportQueueRow>;

const reportDetailRow = reportQueueRow.extend({
  captured_at: timestamp,
  transcript: z.array(z.record(z.unknown())),
});
export type ReportDetailRow = z.infer<typeof reportDetailRow>;

export interface NewMessage {
  conversationId: string;
  clientMessageId: string;
  kind: 'text' | 'image' | 'location' | 'listing_card';
  body: string | null;
  mediaAssetId: string | null;
  lat: number | null;
  lng: number | null;
  listingSnapshot: ListingSnapshot | null;
  flaggedByFilter: boolean;
}

// The columns every message read returns; the image's variants come from its
// media row (visible to participants, media_assets_chat_participant_read).
const MESSAGE_COLUMNS = sql`
  m.id, m.conversation_id, m.client_message_id, m.sender_member_id, sender.role_code as sender_role,
  m.kind_code, m.body, m.media_asset_id, ma.variants as media_variants, ma.thumbhash as media_thumbhash,
  case when m.location is null then null else public.st_y(m.location::public.geometry) end as lat,
  case when m.location is null then null else public.st_x(m.location::public.geometry) end as lng,
  m.listing_snapshot, m.system_event_key, m.created_at`;
const MESSAGE_JOINS = sql`
  left join public.conversation_participants sender
    on sender.tenant_id = m.tenant_id and sender.conversation_id = m.conversation_id
   and sender.member_id = m.sender_member_id
  left join public.media_assets ma on ma.tenant_id = m.tenant_id and ma.id = m.media_asset_id`;

/**
 * Chat SQL (ADR 058). Every query runs through TenantDb in the
 * conversation's own tenant, as the caller's membership there, so the 0009
 * policies decide who reads and writes; the SECURITY DEFINER functions of
 * 0054 do only what those policies can't (open a conversation with both
 * participants, read the cross-tenant inbox, claim the lead, snapshot a report).
 */
@Injectable()
export class ChatRepository {
  async conversationTenantOf(
    tx: DatabaseTransaction,
    conversationId: string,
  ): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.conversation_tenant_of(${conversationId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  async storeTenantOf(tx: DatabaseTransaction, storeId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  async openConversation(
    tx: DatabaseTransaction,
    target: { postId: string | null; storeId: string | null },
    sourceCode: string,
  ): Promise<{ conversationId: string; created: boolean }> {
    const rows = await tx.execute(sql`
      select conversation_id, created
      from public.open_conversation(${target.postId}::uuid, ${target.storeId}::uuid, ${sourceCode})`);
    const [row] = z
      .array(z.object({ conversation_id: z.string(), created: z.boolean() }))
      .length(1)
      .parse([...rows]);
    return { conversationId: row!.conversation_id, created: row!.created };
  }

  async myConversations(
    tx: DatabaseTransaction,
    q: {
      conversationId?: string;
      beforeAt?: string;
      beforeId?: string;
      limit: number;
      archived?: boolean;
    },
  ): Promise<ConversationRow[]> {
    // One conversation by id: whatever its archive state. A list: the inbox or the archive.
    const archived = q.conversationId ? null : (q.archived ?? false);
    const rows = await tx.execute(sql`
      select conversation_id, tenant_id, kind_code, post_id, store_id, post_context_removed, is_locked,
             created_at, activity_at, unread_count, is_archived, my_member_id, my_role_code,
             my_last_read_message_id, others_delivered_up_to, others_read_up_to, post_title, store_slug,
             store_name_bn, store_name_en, counterpart_kind, counterpart_name, blocked, blocked_by_me,
             last_message_id
      from public.my_conversations(${q.conversationId ?? null}::uuid, ${q.beforeAt ?? null}::timestamptz,
                                   ${q.beforeId ?? null}::uuid, ${q.limit}, ${archived}::boolean)`);
    return z.array(conversationRow).parse([...rows]);
  }

  async messagesByIds(tx: DatabaseTransaction, ids: readonly string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select ${MESSAGE_COLUMNS}
      from public.messages m
      ${MESSAGE_JOINS}
      where m.tenant_id = public.current_tenant_id()
        and m.id = any(${`{${ids.join(',')}}`}::uuid[])`);
    return z.array(messageRow).parse([...rows]);
  }

  async history(
    tx: DatabaseTransaction,
    conversationId: string,
    q: { before?: string; after?: string; limit: number },
  ): Promise<MessageRow[]> {
    const rows = q.after
      ? await tx.execute(sql`
          select ${MESSAGE_COLUMNS}
          from public.messages m
          ${MESSAGE_JOINS}
          where m.tenant_id = public.current_tenant_id() and m.conversation_id = ${conversationId}::uuid
            and m.deleted_at is null and m.id > ${q.after}::uuid
          order by m.id asc
          limit ${q.limit}`)
      : await tx.execute(sql`
          select ${MESSAGE_COLUMNS}
          from public.messages m
          ${MESSAGE_JOINS}
          where m.tenant_id = public.current_tenant_id() and m.conversation_id = ${conversationId}::uuid
            and m.deleted_at is null
            and (${q.before ?? null}::uuid is null or m.id < ${q.before ?? null}::uuid)
          order by m.id desc
          limit ${q.limit}`);
    return z.array(messageRow).parse([...rows]);
  }

  /** The caller's message with this client id in the conversation, if they already sent it. */
  async findSent(
    tx: DatabaseTransaction,
    conversationId: string,
    clientMessageId: string,
  ): Promise<MessageRow | undefined> {
    const rows = await tx.execute(sql`
      select ${MESSAGE_COLUMNS}
      from public.messages m
      ${MESSAGE_JOINS}
      where m.tenant_id = public.current_tenant_id() and m.conversation_id = ${conversationId}::uuid
        and m.sender_member_id = public.current_member_id()
        and m.client_message_id = ${clientMessageId}`);
    return z
      .array(messageRow)
      .max(1)
      .parse([...rows])[0];
  }

  /**
   * Inserts as the caller (messages_sender_insert: a participant, the
   * conversation not locked, nobody blocked). A resend with the same client
   * id hits messages_send_idempotency_uq and inserts nothing: undefined.
   */
  async insertMessage(tx: DatabaseTransaction, m: NewMessage): Promise<string | undefined> {
    const location =
      m.lat !== null && m.lng !== null
        ? sql`public.st_setsrid(public.st_makepoint(${m.lng}, ${m.lat}), 4326)::public.geography`
        : sql`null`;
    const rows = await tx.execute(sql`
      insert into public.messages
        (conversation_id, sender_member_id, kind_code, body, media_asset_id, location, listing_snapshot,
         client_message_id, flagged_by_filter)
      values
        (${m.conversationId}::uuid, public.current_member_id(), ${m.kind}, ${m.body},
         ${m.mediaAssetId}::uuid, ${location},
         ${m.listingSnapshot === null ? null : JSON.stringify(m.listingSnapshot)}::jsonb,
         ${m.clientMessageId}, ${m.flaggedByFilter})
      on conflict (tenant_id, conversation_id, sender_member_id, client_message_id) do nothing
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .max(1)
      .parse([...rows])[0]?.id;
  }

  /** Messages so far (system ones aside): the contact filter's window counts these. */
  async countMessages(tx: DatabaseTransaction, conversationId: string): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::integer as n from public.messages m
      where m.tenant_id = public.current_tenant_id() and m.conversation_id = ${conversationId}::uuid
        and m.kind_code <> 'system'`);
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  /** A user's display name (user_profiles is public-read), for "X sent you a message". */
  async displayName(tx: DatabaseTransaction, userId: string): Promise<string | null> {
    const rows = await tx.execute(sql`
      select display_name from public.user_profiles where user_id = ${userId}::uuid`);
    return (
      z
        .array(z.object({ display_name: z.string() }))
        .max(1)
        .parse([...rows])[0]?.display_name ?? null
    );
  }

  /** Everyone still in the conversation, with their user (for fan-out) and read watermark. */
  async participants(tx: DatabaseTransaction, conversationId: string): Promise<ParticipantRow[]> {
    const rows = await tx.execute(sql`
      select cp.member_id, tm.user_id, cp.role_code, cp.last_read_message_id
      from public.conversation_participants cp
      join public.tenant_members tm on tm.tenant_id = cp.tenant_id and tm.id = cp.member_id
      where cp.tenant_id = public.current_tenant_id() and cp.conversation_id = ${conversationId}::uuid
        and cp.left_at is null`);
    return z.array(participantRow).parse([...rows]);
  }

  async claimFirstSellerReply(
    tx: DatabaseTransaction,
    conversationId: string,
    messageId: string,
  ): Promise<LeadClaim | undefined> {
    const rows = await tx.execute(sql`
      select post_id, store_id, source_code, seller_member_id, buyer_member_id, buyer_user_id
      from public.claim_first_seller_reply(${conversationId}::uuid, ${messageId}::uuid)`);
    return z
      .array(leadClaimRow)
      .max(1)
      .parse([...rows])[0];
  }

  /**
   * Moves the caller's own watermark forward to `upTo` (never back), under
   * conversation_participants_own_update. Reading also counts as received.
   * Undefined when `upTo` isn't a message of this conversation.
   */
  async moveWatermark(
    tx: DatabaseTransaction,
    conversationId: string,
    upTo: string,
    kind: 'delivered' | 'read',
  ): Promise<
    { deliveredUpTo: string | null; readUpTo: string | null; unreadCount: number } | undefined
  > {
    const exists = await tx.execute(sql`
      select 1 from public.messages m
      where m.tenant_id = public.current_tenant_id() and m.conversation_id = ${conversationId}::uuid
        and m.id = ${upTo}::uuid`);
    if ([...exists].length === 0) return undefined;
    const read = kind === 'read';
    const rows = await tx.execute(sql`
      update public.conversation_participants cp set
        last_delivered_message_id = case
          when cp.last_delivered_message_id is null or cp.last_delivered_message_id < ${upTo}::uuid
            then ${upTo}::uuid else cp.last_delivered_message_id end,
        last_read_message_id = case
          when ${read} and (cp.last_read_message_id is null or cp.last_read_message_id < ${upTo}::uuid)
            then ${upTo}::uuid else cp.last_read_message_id end,
        last_read_at = case when ${read} then now() else cp.last_read_at end,
        unread_count = case when not ${read} then cp.unread_count else (
          select count(*)::integer from public.messages m
          where m.tenant_id = cp.tenant_id and m.conversation_id = cp.conversation_id
            and m.deleted_at is null and m.sender_member_id is distinct from cp.member_id
            and m.id > greatest(coalesce(cp.last_read_message_id, ${upTo}::uuid), ${upTo}::uuid)
        ) end
      where cp.tenant_id = public.current_tenant_id() and cp.conversation_id = ${conversationId}::uuid
        and cp.member_id = public.current_member_id()
      returning cp.last_delivered_message_id, cp.last_read_message_id, cp.unread_count`);
    const row = z
      .array(receiptRow)
      .max(1)
      .parse([...rows])[0];
    return row
      ? {
          deliveredUpTo: row.last_delivered_message_id,
          readUpTo: row.last_read_message_id,
          unreadCount: row.unread_count,
        }
      : undefined;
  }

  /** The caller's own ready chat image in this tenant, not yet sent in another message. */
  async isUsableChatImage(tx: DatabaseTransaction, mediaId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 from public.media_assets ma
      where ma.tenant_id = public.current_tenant_id() and ma.id = ${mediaId}::uuid
        and ma.uploaded_by_user_id = public.current_user_id()
        and ma.kind_code = 'chat_image' and ma.status_code = 'ready' and ma.deleted_at is null
        and not exists (
          select 1 from public.messages m where m.tenant_id = ma.tenant_id and m.media_asset_id = ma.id)`);
    return [...rows].length > 0;
  }

  /** The caller's own chat image upload in this tenant (for its status), or undefined. */
  async ownChatImageStatus(tx: DatabaseTransaction, mediaId: string): Promise<string | undefined> {
    const rows = await tx.execute(sql`
      select ma.status_code from public.media_assets ma
      where ma.tenant_id = public.current_tenant_id() and ma.id = ${mediaId}::uuid
        and ma.uploaded_by_user_id = public.current_user_id() and ma.kind_code = 'chat_image'`);
    return z
      .array(z.object({ status_code: z.string() }))
      .max(1)
      .parse([...rows])[0]?.status_code;
  }

  /** Archives or brings back the caller's own copy (conversation_participants_own_update, 0009). */
  async setArchived(
    tx: DatabaseTransaction,
    conversationId: string,
    archived: boolean,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.conversation_participants set is_archived = ${archived}
      where tenant_id = public.current_tenant_id() and conversation_id = ${conversationId}::uuid
        and member_id = public.current_member_id()
      returning member_id`);
    return [...rows].length > 0;
  }

  /** Blocks a user (user_blocks is per user, every tenant; G-OWNER RLS). Blocking twice is harmless. */
  async block(tx: DatabaseTransaction, blockedUserId: string): Promise<void> {
    await tx.execute(sql`
      insert into public.user_blocks (blocker_user_id, blocked_user_id, source_tenant_id)
      values (public.current_user_id(), ${blockedUserId}::uuid, public.current_tenant_id())
      on conflict (blocker_user_id, blocked_user_id) do nothing`);
  }

  async unblock(tx: DatabaseTransaction, blockedUserId: string): Promise<void> {
    await tx.execute(sql`
      delete from public.user_blocks
      where blocker_user_id = public.current_user_id() and blocked_user_id = ${blockedUserId}::uuid`);
  }

  async reportConversation(
    tx: DatabaseTransaction,
    conversationId: string,
    reasonCode: string,
    details: string | null,
    maxMessages: number,
  ): Promise<{ reportId: string; created: boolean }> {
    const rows = await tx.execute(sql`
      select report_id, created
      from public.report_conversation(${conversationId}::uuid, ${reasonCode}, ${details}, ${maxMessages})`);
    const [row] = z
      .array(z.object({ report_id: z.string(), created: z.boolean() }))
      .length(1)
      .parse([...rows]);
    return { reportId: row!.report_id, created: row!.created };
  }

  // ---- quick replies (store_quick_replies, can_manage_store RLS) -----------

  async canManageStore(tx: DatabaseTransaction, storeId: string): Promise<boolean> {
    const rows = await tx.execute(sql`select public.can_manage_store(${storeId}::uuid) as ok`);
    return z
      .array(z.object({ ok: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!.ok;
  }

  async quickReplies(tx: DatabaseTransaction, storeId: string): Promise<QuickReplyRow[]> {
    const rows = await tx.execute(sql`
      select id, body, sort_order from public.store_quick_replies
      where tenant_id = public.current_tenant_id() and store_id = ${storeId}::uuid
      order by sort_order, id`);
    return z.array(quickReplyRow).parse([...rows]);
  }

  /** Serialises a store's quick-reply writes, so a count check and its insert can't race. */
  async lockStoreQuickReplies(tx: DatabaseTransaction, storeId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`store_quick_replies:${storeId}`}, 0))`,
    );
  }

  async insertQuickReply(
    tx: DatabaseTransaction,
    storeId: string,
    body: string,
    sortOrder: number,
  ): Promise<QuickReplyRow> {
    const rows = await tx.execute(sql`
      insert into public.store_quick_replies (store_id, body, sort_order, created_by_member_id)
      values (${storeId}::uuid, ${body}, ${sortOrder}, public.current_member_id())
      returning id, body, sort_order`);
    return z
      .array(quickReplyRow)
      .length(1)
      .parse([...rows])[0]!;
  }

  async updateQuickReply(
    tx: DatabaseTransaction,
    storeId: string,
    replyId: string,
    body: string,
    sortOrder: number | undefined,
  ): Promise<QuickReplyRow | undefined> {
    const rows = await tx.execute(sql`
      update public.store_quick_replies
      set body = ${body}, sort_order = coalesce(${sortOrder ?? null}::integer, sort_order)
      where tenant_id = public.current_tenant_id() and store_id = ${storeId}::uuid and id = ${replyId}::uuid
      returning id, body, sort_order`);
    return z
      .array(quickReplyRow)
      .max(1)
      .parse([...rows])[0];
  }

  async deleteQuickReply(
    tx: DatabaseTransaction,
    storeId: string,
    replyId: string,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      delete from public.store_quick_replies
      where tenant_id = public.current_tenant_id() and store_id = ${storeId}::uuid and id = ${replyId}::uuid
      returning id`);
    return [...rows].length > 0;
  }

  // ---- moderation (staff; reports_staff_all, snapshots staff read) ---------

  async reportQueue(
    tx: DatabaseTransaction,
    q: { before?: string; limit: number },
  ): Promise<ReportQueueRow[]> {
    const rows = await tx.execute(sql`
      select r.id as report_id, r.conversation_id, r.reporter_member_id, r.reason_code, r.details,
             r.status_code, coalesce(s.message_count, 0) as message_count, r.created_at
      from public.reports r
      left join public.conversation_report_snapshots s on s.tenant_id = r.tenant_id and s.report_id = r.id
      where r.tenant_id = public.current_tenant_id() and r.conversation_id is not null
        and r.status_code in ('open', 'in_review')
        and (${q.before ?? null}::uuid is null or r.id > ${q.before ?? null}::uuid)
      order by r.id
      limit ${q.limit}`);
    return z.array(reportQueueRow).parse([...rows]);
  }

  async reportDetail(
    tx: DatabaseTransaction,
    reportId: string,
  ): Promise<ReportDetailRow | undefined> {
    const rows = await tx.execute(sql`
      select r.id as report_id, r.conversation_id, r.reporter_member_id, r.reason_code, r.details,
             r.status_code, s.message_count, r.created_at, s.captured_at, s.transcript
      from public.reports r
      join public.conversation_report_snapshots s on s.tenant_id = r.tenant_id and s.report_id = r.id
      where r.tenant_id = public.current_tenant_id() and r.id = ${reportId}::uuid
        and r.conversation_id is not null`);
    return z
      .array(reportDetailRow)
      .max(1)
      .parse([...rows])[0];
  }

  async decideReport(
    tx: DatabaseTransaction,
    reportId: string,
    decision: 'lock' | 'dismiss',
    reasonCode: string,
    note: string | null,
  ): Promise<{ conversationId: string; actionId: string }> {
    const rows = await tx.execute(sql`
      select conversation_id, action_id
      from public.decide_conversation_report(${reportId}::uuid, ${decision}, ${reasonCode}, ${note})`);
    const [row] = z
      .array(z.object({ conversation_id: z.string(), action_id: z.string() }))
      .length(1)
      .parse([...rows]);
    return { conversationId: row!.conversation_id, actionId: row!.action_id };
  }
}

/** The participant roles on the seller's side of a conversation. */
export const SELLER_SIDE: ReadonlySet<ParticipantRole> = new Set(['seller', 'store_staff']);

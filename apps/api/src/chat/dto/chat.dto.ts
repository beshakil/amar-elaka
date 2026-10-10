import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { CONTACT_SOURCES } from '../../engagement/dto/engagement.dto';

// settings-exempt: WGS84 latitude/longitude bounds, a validation range.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;

/** message_kinds (0009) the API speaks. `offer` exists in the schema but isn't offered (not built). */
export const MESSAGE_KINDS = ['text', 'image', 'location', 'listing_card', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const PARTICIPANT_ROLES = ['buyer', 'seller', 'store_staff'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];
export const COUNTERPART_KINDS = ['buyer', 'seller', 'store'] as const;
/** report_reasons (0010) that make sense for a conversation. */
export const CHAT_REPORT_REASONS = [
  'scam',
  'harassment',
  'spam',
  'prohibited_item',
  'other',
] as const;
/** moderation_reasons (0010, 0054) a moderator may lock a conversation for. */
export const CHAT_LOCK_REASONS = [
  'harassment',
  'scam_suspected',
  'spam',
  'contact_info_exposed',
  'policy_violation',
  'illegal_content',
  'credible_threat',
] as const;

const uuid = z.string().uuid();
/**
 * The client's own id for a message, made before it is sent and kept while
 * it waits offline: a resend with the same id is the same message
 * (messages_send_idempotency_uq). URL-safe, 8–64 characters (a UUID fits).
 */
export const clientMessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// ---- requests --------------------------------------------------------------

export const conversationIdParamSchema = z.object({ id: uuid }).strict();
export class ConversationIdParamDto extends createZodDto(conversationIdParamSchema) {}

export const targetIdParamSchema = z.object({ id: uuid }).strict();
export class TargetIdParamDto extends createZodDto(targetIdParamSchema) {}

export const openConversationSchema = z
  .object({
    /** Where the buyer tapped "message" — the chat lead's source (lead_sources). */
    source: z.enum(CONTACT_SOURCES).default('post_detail'),
  })
  .strict();
export type OpenConversationInput = z.infer<typeof openConversationSchema>;
export class OpenConversationDto extends createZodDto(openConversationSchema) {}

export const messageContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), body: z.string().trim().min(1) }).strict(),
  /** A ready chat image from POST /conversations/:id/images (+ confirm). */
  z.object({ kind: z.literal('image'), mediaId: uuid }).strict(),
  z
    .object({
      kind: z.literal('location'),
      lat: z.number().min(-MAX_LAT).max(MAX_LAT),
      lng: z.number().min(-MAX_LNG).max(MAX_LNG),
    })
    .strict(),
  /** A post card: the server builds the snapshot (title, price, cover), never the client. */
  z.object({ kind: z.literal('listing_card'), postId: uuid }).strict(),
]);
export type MessageContent = z.infer<typeof messageContentSchema>;

export const sendMessageSchema = z
  .object({ clientMessageId: clientMessageIdSchema, content: messageContentSchema })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export class SendMessageDto extends createZodDto(sendMessageSchema) {}

export const historyQuerySchema = z
  .object({
    /** Older than this message (scrolling up). */
    before: uuid.optional(),
    /** Newer than this message (catching up after a reconnect), oldest first. */
    after: uuid.optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine((q) => !(q.before && q.after), { message: 'use before or after, not both' });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export class HistoryQueryDto extends createZodDto(historyQuerySchema) {}

export const inboxQuerySchema = z
  .object({
    /** The `nextCursor` of the previous page. */
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    /** true: the archived conversations instead of the inbox. */
    archived: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export class ChatInboxQueryDto extends createZodDto(inboxQuerySchema) {}

export const receiptSchema = z.object({ upToMessageId: uuid }).strict();
export type ReceiptInput = z.infer<typeof receiptSchema>;
export class ReceiptDto extends createZodDto(receiptSchema) {}

export const reportConversationSchema = z
  .object({
    reasonCode: z.enum(CHAT_REPORT_REASONS),
    text: z.string().trim().optional(),
  })
  .strict();
export type ReportConversationInput = z.infer<typeof reportConversationSchema>;
export class ReportConversationDto extends createZodDto(reportConversationSchema) {}

export const chatImagePresignSchema = z
  .object({
    contentType: z.string().min(1),
    byteSize: z.number().int().positive(),
    // settings-exempt: a sha256 hex digest is always 64 characters — a protocol constant.
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();
export type ChatImagePresignInput = z.infer<typeof chatImagePresignSchema>;
export class ChatImagePresignDto extends createZodDto(chatImagePresignSchema) {}

export const chatImageParamSchema = z.object({ id: uuid, mediaId: uuid }).strict();
export class ChatImageParamDto extends createZodDto(chatImageParamSchema) {}

export const quickReplyBodySchema = z
  .object({ body: z.string().trim().min(1), sortOrder: z.number().int().nonnegative().optional() })
  .strict();
export type QuickReplyInput = z.infer<typeof quickReplyBodySchema>;
export class QuickReplyBodyDto extends createZodDto(quickReplyBodySchema) {}

export const quickReplyParamSchema = z.object({ id: uuid, replyId: uuid }).strict();
export class QuickReplyParamDto extends createZodDto(quickReplyParamSchema) {}

export const chatReportQueueQuerySchema = z
  .object({ before: uuid.optional(), limit: z.coerce.number().int().positive().optional() })
  .strict();
export type ChatReportQueueQuery = z.infer<typeof chatReportQueueQuerySchema>;
export class ChatReportQueueQueryDto extends createZodDto(chatReportQueueQuerySchema) {}

export const chatReportDecisionSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('lock'),
      reasonCode: z.enum(CHAT_LOCK_REASONS),
      note: z.string().trim().optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal('dismiss'),
      reasonCode: z.literal('report_unfounded').default('report_unfounded'),
      note: z.string().trim().optional(),
    })
    .strict(),
]);
export type ChatReportDecision = z.infer<typeof chatReportDecisionSchema>;
export const chatReportDecisionBodySchema = z
  .object({ decision: chatReportDecisionSchema })
  .strict();
export class ChatReportDecisionDto extends createZodDto(chatReportDecisionBodySchema) {}

export const reportIdParamSchema = z.object({ id: uuid }).strict();
export class ReportIdParamDto extends createZodDto(reportIdParamSchema) {}

// ---- responses -------------------------------------------------------------

const imageVariant = z.object({ url: z.string(), width: z.number(), height: z.number() });
const money = z.string().nullable();

/** A post card as it was when shared, or the neutral marker after the post's scrub (Q46). */
export const listingSnapshotSchema = z.union([
  z.object({
    state: z.literal('shared'),
    postId: z.string(),
    tenantId: z.string(),
    title: z.string(),
    price: money,
    cover: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
  }),
  z.object({ state: z.literal('listing_removed') }),
]);
export type ListingSnapshot = z.infer<typeof listingSnapshotSchema>;

export const messageViewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** The sender's own id for it; the sender's queue drops its copy when this comes back. */
  clientMessageId: z.string(),
  /** Null for a system message. */
  senderMemberId: z.string().nullable(),
  senderRole: z.enum(PARTICIPANT_ROLES).nullable(),
  kind: z.enum(MESSAGE_KINDS),
  body: z.string().nullable(),
  /** Signed, short-lived URLs (chat_media_url_ttl_seconds); fetch the message again for fresh ones. */
  image: z
    .object({
      thumb: imageVariant,
      card: imageVariant,
      full: imageVariant,
      thumbhash: z.string().nullable(),
    })
    .nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  listing: listingSnapshotSchema.nullable(),
  /** i18n key of a system message, e.g. conversation_locked. */
  systemEvent: z.string().nullable(),
  createdAt: z.string(),
});
export type MessageView = z.infer<typeof messageViewSchema>;
export class MessageViewDto extends createZodDto(messageViewSchema) {}

export const conversationViewSchema = z.object({
  id: z.string(),
  /** Where it lives: the post's or store's own tenant (not necessarily the caller's). */
  tenantId: z.string(),
  kind: z.enum(['post_inquiry', 'store_inquiry', 'direct']),
  /** The post it's about, while its page is still viewable; cover and price while it's listed. */
  post: z
    .object({
      id: z.string(),
      title: z.string(),
      price: z.string().nullable(),
      cover: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
    })
    .nullable(),
  /** The post was removed for good (scrubbed): no link, no title. */
  postRemoved: z.boolean(),
  store: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.object({ bn: z.string(), en: z.string().nullable() }),
    })
    .nullable(),
  /** Who's on the other side: a display name only — never a phone number. */
  counterpart: z.object({ kind: z.enum(COUNTERPART_KINDS), name: z.string().nullable() }),
  me: z.object({ memberId: z.string(), role: z.enum(PARTICIPANT_ROLES) }),
  unreadCount: z.number(),
  isArchived: z.boolean(),
  isLocked: z.boolean(),
  /** Either side blocked the other: nobody can send. */
  isBlocked: z.boolean(),
  /** The caller did the blocking (and may unblock). */
  blockedByMe: z.boolean(),
  canSend: z.boolean(),
  /**
   * Delivery state for the caller's own messages: a message is `read` when
   * its id ≤ othersReadUpTo, `delivered` when ≤ othersDeliveredUpTo, else `sent`.
   */
  othersDeliveredUpTo: z.string().nullable(),
  othersReadUpTo: z.string().nullable(),
  myReadUpTo: z.string().nullable(),
  lastMessage: messageViewSchema.nullable(),
  activityAt: z.string(),
});
export type ConversationView = z.infer<typeof conversationViewSchema>;
export class ConversationViewDto extends createZodDto(conversationViewSchema) {}

export const openConversationResultSchema = z.object({
  conversation: conversationViewSchema,
  /** False: the buyer's existing conversation about it (reopening never makes a second). */
  created: z.boolean(),
});
export type OpenConversationResult = z.infer<typeof openConversationResultSchema>;
export class OpenConversationResultDto extends createZodDto(openConversationResultSchema) {}

export const inboxPageSchema = z.object({
  items: z.array(conversationViewSchema),
  nextCursor: z.string().nullable(),
});
export type InboxPage = z.infer<typeof inboxPageSchema>;
export class ChatInboxPageDto extends createZodDto(inboxPageSchema) {}

export const historyPageSchema = z.object({
  /** Newest first for `before` (or no cursor), oldest first for `after`. */
  items: z.array(messageViewSchema),
  hasMore: z.boolean(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export class HistoryPageDto extends createZodDto(historyPageSchema) {}

export const sendResultSchema = z.object({
  message: messageViewSchema,
  /** False: this clientMessageId was already sent (a resend after reconnect); nothing new was stored. */
  created: z.boolean(),
});
export type SendResult = z.infer<typeof sendResultSchema>;
export class SendResultDto extends createZodDto(sendResultSchema) {}

export const receiptResultSchema = z.object({
  conversationId: z.string(),
  memberId: z.string(),
  deliveredUpTo: z.string().nullable(),
  readUpTo: z.string().nullable(),
  unreadCount: z.number(),
});
export type ReceiptResult = z.infer<typeof receiptResultSchema>;
export class ReceiptResultDto extends createZodDto(receiptResultSchema) {}

export const reportResultSchema = z.object({ reportId: z.string(), created: z.boolean() });
export type ReportResult = z.infer<typeof reportResultSchema>;
export class ChatReportResultDto extends createZodDto(reportResultSchema) {}

export const chatImagePresignedSchema = z.object({
  mediaId: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    expiresInSeconds: z.number(),
  }),
});
export type ChatImagePresigned = z.infer<typeof chatImagePresignedSchema>;
export class ChatImagePresignedDto extends createZodDto(chatImagePresignedSchema) {}

export const chatImageStatusSchema = z.object({
  mediaId: z.string(),
  status: z.enum(['pending_upload', 'processing', 'ready', 'rejected', 'quarantined']),
});
export type ChatImageStatus = z.infer<typeof chatImageStatusSchema>;
export class ChatImageStatusDto extends createZodDto(chatImageStatusSchema) {}

export const quickReplyViewSchema = z.object({
  id: z.string(),
  body: z.string(),
  sortOrder: z.number(),
});
export type QuickReplyView = z.infer<typeof quickReplyViewSchema>;
export const quickReplyListSchema = z.object({
  items: z.array(quickReplyViewSchema),
  max: z.number(),
  maxLength: z.number(),
});
export type QuickReplyList = z.infer<typeof quickReplyListSchema>;
export class QuickReplyListDto extends createZodDto(quickReplyListSchema) {}
export class QuickReplyViewDto extends createZodDto(quickReplyViewSchema) {}

export const chatReportQueueItemSchema = z.object({
  reportId: z.string(),
  conversationId: z.string(),
  reasonCode: z.string(),
  details: z.string().nullable(),
  status: z.string(),
  /** Match it against the transcript's senderMemberId to see which side reported. */
  reporterMemberId: z.string(),
  messageCount: z.number(),
  createdAt: z.string(),
});
export type ChatReportQueueItem = z.infer<typeof chatReportQueueItemSchema>;
export const chatReportQueueSchema = z.object({
  items: z.array(chatReportQueueItemSchema),
  nextBefore: z.string().nullable(),
});
export type ChatReportQueue = z.infer<typeof chatReportQueueSchema>;
export class ChatReportQueueDto extends createZodDto(chatReportQueueSchema) {}

export const transcriptEntrySchema = z.object({
  id: z.string(),
  senderMemberId: z.string().nullable(),
  senderRole: z.string().nullable(),
  kind: z.string(),
  body: z.string().nullable(),
  mediaAssetId: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  listing: z.record(z.unknown()).nullable(),
  systemEvent: z.string().nullable(),
  flaggedByFilter: z.boolean(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});
export const chatReportDetailSchema = chatReportQueueItemSchema.extend({
  capturedAt: z.string(),
  transcript: z.array(transcriptEntrySchema),
});
export type ChatReportDetail = z.infer<typeof chatReportDetailSchema>;
export class ChatReportDetailDto extends createZodDto(chatReportDetailSchema) {}

export const chatReportDecisionResultSchema = z.object({
  reportId: z.string(),
  conversationId: z.string(),
  decision: z.enum(['lock', 'dismiss']),
  moderationActionId: z.string(),
});
export type ChatReportDecisionResult = z.infer<typeof chatReportDecisionResultSchema>;
export class ChatReportDecisionResultDto extends createZodDto(chatReportDecisionResultSchema) {}

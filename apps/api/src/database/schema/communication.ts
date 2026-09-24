import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { categories } from './catalog';
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz } from './columns';
import {
  alertFrequencies,
  conversationKinds,
  deliveryPurposes,
  deliveryStatuses,
  leadChannels,
  leadSources,
  messageKinds,
  moderationReasons,
  notificationChannels,
  notificationTypes,
  participantRoles,
} from './enums';
import { users } from './identity';
import { tenants } from './tenancy';

// ---- conversations (§8.1): TENANT-SCOPED -----------------------------------

export const conversations = pgTable('conversations', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  kindCode: text('kind_code')
    .notNull()
    .references(() => conversationKinds.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, post_id) -> posts, SET NULL.
  postId: uuid('post_id'),
  // Composite FK (tenant_id, store_id) -> stores, SET NULL.
  storeId: uuid('store_id'),
  dedupeKey: text('dedupe_key'),
  // Composite FK (tenant_id, created_by_member_id) -> tenant_members, RESTRICT.
  createdByMemberId: uuid('created_by_member_id').notNull(),
  lastMessageAt: timestamptz('last_message_at'),
  lastMessagePreview: text('last_message_preview'),
  isLocked: boolean('is_locked').notNull().default(false),
  postContextRemoved: boolean('post_context_removed').notNull().default(false),
  lockedReasonCode: text('locked_reason_code').references(() => moderationReasons.code, {
    onDelete: 'restrict',
  }),
  ...auditColumns(),
});

// ---- conversation_participants (§8.2): TENANT-SCOPED, join table (§13.2) -
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, conversation_id) -> conversations FK, which stays
// bare (same pattern as commerce.ts's credit_wallets).

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    tenantId: uuid('tenant_id').notNull(),
    // Composite FK (tenant_id, conversation_id) -> conversations, CASCADE.
    conversationId: uuid('conversation_id').notNull(),
    // Composite FK (tenant_id, member_id) -> tenant_members, RESTRICT.
    memberId: uuid('member_id').notNull(),
    roleCode: text('role_code')
      .notNull()
      .references(() => participantRoles.code, { onDelete: 'restrict' }),
    lastMessageAt: timestamptz('last_message_at'),
    lastReadAt: timestamptz('last_read_at'),
    unreadCount: integer('unread_count').notNull().default(0),
    isMuted: boolean('is_muted').notNull().default(false),
    isArchived: boolean('is_archived').notNull().default(false),
    leftAt: timestamptz('left_at'),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.conversationId, table.memberId] })],
);

// ---- messages (§8.3): TENANT-SCOPED. Plain table, not partitioned. -------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, conversation_id) -> conversations FK.

export const messages = pgTable('messages', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, conversation_id) -> conversations, RESTRICT.
  conversationId: uuid('conversation_id').notNull(),
  // Composite FK (tenant_id, sender_member_id) -> tenant_members, RESTRICT.
  senderMemberId: uuid('sender_member_id'),
  kindCode: text('kind_code')
    .notNull()
    .default('text')
    .references(() => messageKinds.code, { onDelete: 'restrict' }),
  body: text('body'),
  // Composite FK (tenant_id, media_asset_id) -> media_assets, RESTRICT.
  mediaAssetId: uuid('media_asset_id'),
  offerAmount: numeric('offer_amount', { precision: 12, scale: 2 }),
  location: geographyPoint('location'),
  systemEventKey: text('system_event_key'),
  // Composite FK (tenant_id, reply_to_message_id) -> messages (self), SET NULL.
  replyToMessageId: uuid('reply_to_message_id'),
  listingSnapshot: jsonb('listing_snapshot').$type<Record<string, unknown>>(),
  clientMessageId: text('client_message_id').notNull(),
  flaggedByFilter: boolean('flagged_by_filter').notNull().default(false),
  editedAt: timestamptz('edited_at'),
  ...softDeleteColumns(),
});

// ---- notification_templates (§8.4): GLOBAL ---------------------------------

export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  typeCode: text('type_code')
    .notNull()
    .references(() => notificationTypes.code, { onDelete: 'restrict' }),
  channelCode: text('channel_code')
    .notNull()
    .references(() => notificationChannels.code, { onDelete: 'restrict' }),
  locale: text('locale').notNull(),
  version: integer('version').notNull().default(1),
  titleTemplate: text('title_template'),
  bodyTemplate: text('body_template').notNull(),
  variables: text('variables')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  maxSmsSegments: smallint('max_sms_segments'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

// ---- notifications (§8.5): GLOBAL, no tenant_id ----------------------------

export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  typeCode: text('type_code')
    .notNull()
    .references(() => notificationTypes.code, { onDelete: 'restrict' }),
  params: jsonb('params')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  deepLink: text('deep_link'),
  dedupeKey: text('dedupe_key'),
  entityId: uuid('entity_id'),
  readAt: timestamptz('read_at'),
  archivedAt: timestamptz('archived_at'),
  expiresAt: timestamptz('expires_at'),
  ...auditColumns(),
});

// ---- notification_deliveries (§8.6): GLOBAL --------------------------------

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: id(),
  notificationId: uuid('notification_id').references(() => notifications.id, {
    onDelete: 'set null',
  }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  billedTenantId: uuid('billed_tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  purposeCode: text('purpose_code')
    .notNull()
    .references(() => deliveryPurposes.code, { onDelete: 'restrict' }),
  channelCode: text('channel_code')
    .notNull()
    .references(() => notificationChannels.code, { onDelete: 'restrict' }),
  recipientMasked: text('recipient_masked').notNull(),
  providerCode: text('provider_code').notNull(),
  providerMessageId: text('provider_message_id'),
  statusCode: text('status_code')
    .notNull()
    .default('queued')
    .references(() => deliveryStatuses.code, { onDelete: 'restrict' }),
  attemptCount: smallint('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  smsSegments: smallint('sms_segments'),
  costAmount: numeric('cost_amount', { precision: 12, scale: 2 }),
  sentAt: timestamptz('sent_at'),
  deliveredAt: timestamptz('delivered_at'),
  ...auditColumns(),
});

// ---- user_notification_preferences (§8.7): GLOBAL --------------------------

export const userNotificationPreferences = pgTable(
  'user_notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    typeCode: text('type_code')
      .notNull()
      .references(() => notificationTypes.code, { onDelete: 'restrict' }),
    channelCode: text('channel_code')
      .notNull()
      .references(() => notificationChannels.code, { onDelete: 'restrict' }),
    isEnabled: boolean('is_enabled').notNull(),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.typeCode, table.channelCode] })],
);

// ---- user_blocks (§8.10): GLOBAL -------------------------------------------

export const userBlocks = pgTable('user_blocks', {
  id: id(),
  blockerUserId: uuid('blocker_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  blockedUserId: uuid('blocked_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sourceTenantId: uuid('source_tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  note: text('note'),
  ...auditColumns(),
});

// ---- lead_events (§8.8): TENANT-SCOPED -------------------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite FKs below (at least one target column is always non-null, per
// the CHECK constraint).

export const leadEvents = pgTable('lead_events', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  channelCode: text('channel_code')
    .notNull()
    .references(() => leadChannels.code, { onDelete: 'restrict' }),
  sourceCode: text('source_code')
    .notNull()
    .references(() => leadSources.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT (billing/audit evidence).
  postId: uuid('post_id'),
  // Composite FK (tenant_id, store_id) -> stores, SET NULL.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, place_id) -> places, SET NULL.
  placeId: uuid('place_id'),
  // Composite FK (tenant_id, target_member_id) -> tenant_members, SET NULL.
  targetMemberId: uuid('target_member_id'),
  // Composite FK (tenant_id, actor_member_id) -> tenant_members, SET NULL.
  actorMemberId: uuid('actor_member_id'),
  anonSessionHash: text('anon_session_hash'),
  // Composite FK (tenant_id, ad_booking_id) -> ad_bookings, SET NULL.
  adBookingId: uuid('ad_booking_id'),
  // Composite FK (tenant_id, boost_id) -> boosts, SET NULL.
  boostId: uuid('boost_id'),
  subjectScrubbed: boolean('subject_scrubbed').notNull().default(false),
  occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
  ...auditColumns(),
});

// ---- lead_daily_stats (§8.9): TENANT-SCOPED --------------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite FKs below (exactly one target column is always non-null).

export const leadDailyStats = pgTable('lead_daily_stats', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  statDate: date('stat_date').notNull(),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT.
  postId: uuid('post_id'),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, place_id) -> places, RESTRICT.
  placeId: uuid('place_id'),
  channelCode: text('channel_code')
    .notNull()
    .references(() => leadChannels.code, { onDelete: 'restrict' }),
  eventCount: integer('event_count').notNull().default(0),
  subjectScrubbed: boolean('subject_scrubbed').notNull().default(false),
  uniqueActorCount: integer('unique_actor_count').notNull().default(0),
  ...auditColumns(),
});

// ---- saved_searches (§8.11): GLOBAL ----------------------------------------

export const savedSearches = pgTable('saved_searches', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  queryText: text('query_text'),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  filters: jsonb('filters')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  priceMin: numeric('price_min', { precision: 12, scale: 2 }),
  priceMax: numeric('price_max', { precision: 12, scale: 2 }),
  center: geographyPoint('center').notNull(),
  radiusKm: numeric('radius_km', { precision: 5, scale: 2 }).notNull().default('10'),
  alertFrequencyCode: text('alert_frequency_code')
    .notNull()
    .default('daily')
    .references(() => alertFrequencies.code, { onDelete: 'restrict' }),
  lastAlertedAt: timestamptz('last_alerted_at'),
  lastMatchedPostId: uuid('last_matched_post_id'),
  isActive: boolean('is_active').notNull().default(true),
  lastEngagedAt: timestamptz('last_engaged_at'),
  pausedAt: timestamptz('paused_at'),
  ...softDeleteColumns(),
});

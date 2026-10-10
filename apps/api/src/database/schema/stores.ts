import {
  boolean,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz } from './columns';
import { categories } from './catalog';
import { subscriptionPlans } from './commerce';
import {
  sellerTypes,
  sellerVerificationLevels,
  storeMemberRoles,
  storeStatuses,
  storeTiers,
} from './enums';
import { users } from './identity';
import { tenants } from './tenancy';

/** §5.1 Seller-specific info and reputation for a member (1:1 with tenant_members). */
export const sellerProfiles = pgTable('seller_profiles', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, member_id) -> tenant_members, CASCADE; see
  // content.ts's authorMemberId note for why this stays a bare column.
  memberId: uuid('member_id').notNull(),
  sellerTypeCode: text('seller_type_code')
    .notNull()
    .default('individual')
    .references(() => sellerTypes.code, { onDelete: 'restrict' }),
  businessName: text('business_name'),
  verificationLevelCode: text('verification_level_code')
    .notNull()
    .default('phone')
    .references(() => sellerVerificationLevels.code, { onDelete: 'restrict' }),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
  responseRatePct: numeric('response_rate_pct', { precision: 5, scale: 2 }),
  medianResponseSeconds: integer('median_response_seconds'),
  activePostCount: integer('active_post_count').notNull().default(0),
  ...auditColumns(),
});

/** §5.2 A seller's branded storefront, optionally tied to a physical place. */
export const stores = pgTable('stores', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, owner_member_id) -> tenant_members, RESTRICT.
  ownerMemberId: uuid('owner_member_id').notNull(),
  // Composite FK (tenant_id, place_id) -> places, SET NULL.
  placeId: uuid('place_id'),
  slug: text('slug').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  // 0043: name_bn in Latin letters, for duplicate detection.
  nameTranslit: text('name_translit'),
  // 0044: the owner's "closed today" toggle.
  closedUntil: timestamptz('closed_until'),
  description: text('description'),
  // Composite FKs (tenant_id, *_media_id) -> media_assets, SET NULL.
  logoMediaId: uuid('logo_media_id'),
  coverMediaId: uuid('cover_media_id'),
  phoneE164: text('phone_e164'),
  whatsappE164: text('whatsapp_e164'),
  addressText: text('address_text'),
  // Composite FK (tenant_id, locality_id) -> localities, SET NULL.
  localityId: uuid('locality_id'),
  location: geographyPoint('location'),
  statusCode: text('status_code')
    .notNull()
    .default('pending_review')
    .references(() => storeStatuses.code, { onDelete: 'restrict' }),
  currentPlanCode: text('current_plan_code').references(() => subscriptionPlans.code, {
    onDelete: 'restrict',
  }),
  // 0050: basic | pro | premium. Limits per tier are settings; only staff or
  // the system move it (stores_b_protect_tier_and_slug).
  tierCode: text('tier_code')
    .notNull()
    .default('basic')
    .references(() => storeTiers.code, { onDelete: 'restrict' }),
  // 0050: what the store sells or does (a place-kind category, as its map pin).
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'restrict' }),
  // 0050: the owner may change the slug once; the old one keeps resolving.
  slugChangedAt: timestamptz('slug_changed_at'),
  previousSlug: text('previous_slug'),
  isVerified: boolean('is_verified').notNull().default(false),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
  // store_follows rows, kept by trigger (0032).
  followerCount: integer('follower_count').notNull().default(0),
  searchSyncedAt: timestamptz('search_synced_at'),
  ...softDeleteColumns(),
});

/** §5.3 Additional people who can manage a store (the owner isn't duplicated here). */
export const storeMembers = pgTable('store_members', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, store_id) -> stores, CASCADE.
  storeId: uuid('store_id').notNull(),
  // Composite FK (tenant_id, member_id) -> tenant_members, CASCADE.
  memberId: uuid('member_id').notNull(),
  // 0050: manager | editor ('staff' retired, its rows became editors).
  roleCode: text('role_code')
    .notNull()
    .default('editor')
    .references(() => storeMemberRoles.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, invited_by_member_id) -> tenant_members, SET NULL.
  invitedByMemberId: uuid('invited_by_member_id'),
  acceptedAt: timestamptz('accepted_at'),
  ...auditColumns(),
});

/** §5.4 A user following a store (tenant = the store's owning tenant). */
export const storeFollows = pgTable('store_follows', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id').notNull(),
  notifyNewPosts: boolean('notify_new_posts').notNull().default(true),
  ...auditColumns(),
});

/** 0044 A store's weekly schedule (same shape as place_hours). */
export const storeHours = pgTable('store_hours', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, store_id) -> stores, CASCADE.
  storeId: uuid('store_id').notNull(),
  isoDayOfWeek: smallint('iso_day_of_week').notNull(),
  opensAt: time('opens_at').notNull(),
  closesAt: time('closes_at').notNull(),
  closesNextDay: boolean('closes_next_day').notNull().default(false),
  ...auditColumns(),
});

/** 0052 One bulk upload into a store (ADR 056): its file, its progress, its counts. */
export const storeImports = pgTable('store_imports', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, store_id) -> stores, CASCADE.
  storeId: uuid('store_id').notNull(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, created_by_member_id) -> tenant_members, RESTRICT.
  createdByMemberId: uuid('created_by_member_id').notNull(),
  // Composite FKs (tenant_id, *_media_id) -> media_assets, SET NULL (the files are swept later).
  sheetMediaId: uuid('sheet_media_id'),
  imagesMediaId: uuid('images_media_id'),
  sheetFormat: text('sheet_format').notNull(),
  dryRun: boolean('dry_run').notNull().default(false),
  // queued | running | succeeded | failed (CHECK)
  statusCode: text('status_code').notNull().default('queued'),
  errorCode: text('error_code'),
  totalRows: integer('total_rows'),
  processedRows: integer('processed_rows').notNull().default(0),
  createdCount: integer('created_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  startedAt: timestamptz('started_at'),
  finishedAt: timestamptz('finished_at'),
  ...auditColumns(),
});

/** 0052 One sheet row's outcome: created / valid (dry run) / skipped / failed, with the exact reason. */
export const storeImportRows = pgTable('store_import_rows', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, import_id) -> store_imports, CASCADE.
  importId: uuid('import_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  outcome: text('outcome').notNull(),
  reasonCode: text('reason_code'),
  reason: text('reason'),
  // Composite FK (tenant_id, post_id) -> posts, SET NULL.
  postId: uuid('post_id'),
  ...auditColumns(),
});

/** 0054 A store's canned chat replies, for its owner and managers (count and length are settings). */
export const storeQuickReplies = pgTable('store_quick_replies', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, store_id) -> stores, CASCADE.
  storeId: uuid('store_id').notNull(),
  body: text('body').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  // Composite FK (tenant_id, created_by_member_id) -> tenant_members, RESTRICT.
  createdByMemberId: uuid('created_by_member_id').notNull(),
  ...auditColumns(),
});

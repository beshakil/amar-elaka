import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  uuid,
} from 'drizzle-orm/pg-core';
import { categories, categoryFieldSchemas, geoAreas } from './catalog';
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz } from './columns';
import {
  claimStatuses,
  claimVerificationMethods,
  mediaKinds,
  mediaStatuses,
  mediaVisibilities,
  moderationReasons,
  ownershipResolutions,
  placeSources,
  placeStatuses,
  postDeletionReasons,
  postStatuses,
  priceTypes,
} from './enums';
import { users } from './identity';
import { tenants } from './tenancy';

/** §4.1 One uploaded file (image/video/document) in object storage. */
export const mediaAssets = pgTable('media_assets', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  kindCode: text('kind_code')
    .notNull()
    .references(() => mediaKinds.code, { onDelete: 'restrict' }),
  visibilityCode: text('visibility_code')
    .notNull()
    .default('public')
    .references(() => mediaVisibilities.code, { onDelete: 'restrict' }),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  checksumSha256: text('checksum_sha256').notNull(),
  blurhash: text('blurhash'),
  variants: jsonb('variants')
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  statusCode: text('status_code')
    .notNull()
    .default('pending_upload')
    .references(() => mediaStatuses.code, { onDelete: 'restrict' }),
  evidenceHold: boolean('evidence_hold').notNull().default(false),
  purgeDueAt: timestamptz('purge_due_at'),
  purgedAt: timestamptz('purged_at'),
  ...softDeleteColumns(),
});

/** §4.2 A user listing: item for sale, service, job, rental — the core table. */
export const posts = pgTable('posts', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, author_member_id) -> tenant_members; column-list
  // SET NULL isn't expressible via drizzle's foreignKey() (see tenancy.ts's
  // homeLocalityId note), so this stays a bare column here.
  authorMemberId: uuid('author_member_id'),
  // Composite FK (tenant_id, store_id) -> stores, SET NULL (store_id) — real
  // since 0006, stays bare here for the same column-list reason as above.
  storeId: uuid('store_id'),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'restrict' }),
  fieldSchemaId: uuid('field_schema_id')
    .notNull()
    .references(() => categoryFieldSchemas.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  description: text('description'),
  fields: jsonb('fields')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  price: numeric('price', { precision: 12, scale: 2 }).generatedAlwaysAs(
    sql`(((fields ->> 'price'))::numeric(12,2))`,
  ),
  bedrooms: smallint('bedrooms').generatedAlwaysAs(sql`(((fields ->> 'bedrooms'))::smallint)`),
  seats: smallint('seats').generatedAlwaysAs(sql`(((fields ->> 'seats'))::smallint)`),
  area: numeric('area', { precision: 12, scale: 2 }).generatedAlwaysAs(
    sql`(((fields ->> 'area'))::numeric(12,2))`,
  ),
  priceTypeCode: text('price_type_code').references(() => priceTypes.code, {
    onDelete: 'restrict',
  }),
  currency: char('currency', { length: 3 }).notNull().default('BDT'),
  // Composite FK (tenant_id, locality_id) -> localities; same column-list
  // SET NULL limitation as authorMemberId above.
  localityId: uuid('locality_id'),
  geoAreaId: uuid('geo_area_id').references(() => geoAreas.id, { onDelete: 'restrict' }),
  geoAreaIdCoarse: uuid('geo_area_id_coarse')
    .notNull()
    .references(() => geoAreas.id, { onDelete: 'restrict' }),
  location: geographyPoint('location'),
  outsideBoundary: boolean('outside_boundary').notNull().default(false),
  ownershipResolutionCode: text('ownership_resolution_code')
    .notNull()
    .default('inside_boundary')
    .references(() => ownershipResolutions.code, { onDelete: 'restrict' }),
  locationIsApproximate: boolean('location_is_approximate').notNull().default(true),
  contactPhoneE164: text('contact_phone_e164'),
  contactName: text('contact_name'),
  showPhone: boolean('show_phone').notNull().default(true),
  allowChat: boolean('allow_chat').notNull().default(true),
  statusCode: text('status_code')
    .notNull()
    .default('draft')
    .references(() => postStatuses.code, { onDelete: 'restrict' }),
  soldAt: timestamptz('sold_at'),
  soldPrice: numeric('sold_price', { precision: 12, scale: 2 }),
  moderationReasonCode: text('moderation_reason_code').references(() => moderationReasons.code, {
    onDelete: 'restrict',
  }),
  moderatedByUserId: uuid('moderated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  moderatedAt: timestamptz('moderated_at'),
  publishedAt: timestamptz('published_at'),
  expiresAt: timestamptz('expires_at'),
  bumpedAt: timestamptz('bumped_at'),
  creditsCharged: integer('credits_charged').notNull().default(0),
  viewCount: integer('view_count').notNull().default(0),
  searchSyncedAt: timestamptz('search_synced_at'),
  hiddenByOwner: boolean('hidden_by_owner').notNull().default(false),
  scrubbedAt: timestamptz('scrubbed_at'),
  scrubReason: text('scrub_reason'),
  deletionReasonCode: text('deletion_reason_code').references(() => postDeletionReasons.code, {
    onDelete: 'restrict',
  }),
  deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...auditColumns(),
  deletedAt: timestamptz('deleted_at'),
});

/** §4.4 Local business directory entry (shop, pharmacy, clinic, school…). */
export const places = pgTable('places', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'restrict' }),
  fieldSchemaId: uuid('field_schema_id').references(() => categoryFieldSchemas.id, {
    onDelete: 'restrict',
  }),
  slug: text('slug').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  description: text('description'),
  fields: jsonb('fields')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  phones: text('phones')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  websiteUrl: text('website_url'),
  facebookUrl: text('facebook_url'),
  addressText: text('address_text'),
  // Composite FK (tenant_id, locality_id) -> localities; see posts.localityId.
  localityId: uuid('locality_id'),
  geoAreaId: uuid('geo_area_id').references(() => geoAreas.id, { onDelete: 'restrict' }),
  location: geographyPoint('location').notNull(),
  outsideBoundary: boolean('outside_boundary').notNull().default(false),
  isLandmark: boolean('is_landmark').notNull().default(false),
  landmarkRadiusKm: numeric('landmark_radius_km', { precision: 6, scale: 2 }),
  sourceCode: text('source_code')
    .notNull()
    .references(() => placeSources.code, { onDelete: 'restrict' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Composite FK (tenant_id, claimed_by_member_id) -> tenant_members; see
  // posts.authorMemberId for why this stays a bare column.
  claimedByMemberId: uuid('claimed_by_member_id'),
  fieldVerifiedAt: timestamptz('field_verified_at'),
  statusCode: text('status_code')
    .notNull()
    .default('pending_review')
    .references(() => placeStatuses.code, { onDelete: 'restrict' }),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
  searchSyncedAt: timestamptz('search_synced_at'),
  ...softDeleteColumns(),
});

/** §4.5 Weekly opening hours for a place; several rows per day allowed. */
export const placeHours = pgTable('place_hours', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, place_id) -> places, ON DELETE CASCADE.
  placeId: uuid('place_id').notNull(),
  isoDayOfWeek: smallint('iso_day_of_week').notNull(),
  opensAt: time('opens_at').notNull(),
  closesAt: time('closes_at').notNull(),
  closesNextDay: boolean('closes_next_day').notNull().default(false),
  ...auditColumns(),
});

/** §4.6 A member's request to be recognised as the owner of a place. */
export const placeClaims = pgTable('place_claims', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FKs (tenant_id, place_id) -> places and
  // (tenant_id, claimant_member_id) -> tenant_members, both RESTRICT.
  placeId: uuid('place_id').notNull(),
  claimantMemberId: uuid('claimant_member_id').notNull(),
  verificationMethodCode: text('verification_method_code')
    .notNull()
    .references(() => claimVerificationMethods.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('pending')
    .references(() => claimStatuses.code, { onDelete: 'restrict' }),
  claimantNote: text('claimant_note'),
  // Composite FK (tenant_id, agent_visit_id) -> agent_visits, SET NULL (0012).
  agentVisitId: uuid('agent_visit_id'),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  reviewedAt: timestamptz('reviewed_at'),
  rejectionReasonCode: text('rejection_reason_code').references(() => moderationReasons.code, {
    onDelete: 'restrict',
  }),
  ...auditColumns(),
});

/** §4.7 A user's bookmarked post (tenant = the post's owning tenant). */
export const savedPosts = pgTable('saved_posts', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT: saves survive post
  // deletion (§13.31).
  postId: uuid('post_id').notNull(),
  note: text('note'),
  ...auditColumns(),
});

/**
 * §4.3 Links a media asset to the thing it illustrates. Polymorphic: exactly
 * one owner column is non-null (enforced by CHECK in SQL). All ten owner
 * columns now have a real composite FK (the last six were closed by 0012,
 * including four (review/business_verification/notice/lost_found_item) that
 * 0010/0011 had documented as deferred-to-0012 but never actually closed).
 */
export const mediaAttachments = pgTable('media_attachments', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, media_asset_id) -> media_assets, CASCADE.
  mediaAssetId: uuid('media_asset_id').notNull(),
  // Composite FKs (tenant_id, *) -> posts / places / place_claims, CASCADE.
  postId: uuid('post_id'),
  placeId: uuid('place_id'),
  // Composite FKs (tenant_id, *) -> stores / reviews / business_verifications
  // / notices / lost_found_items / agent_visits / ticket_messages, all CASCADE.
  storeId: uuid('store_id'),
  reviewId: uuid('review_id'),
  placeClaimId: uuid('place_claim_id'),
  businessVerificationId: uuid('business_verification_id'),
  noticeId: uuid('notice_id'),
  lostFoundItemId: uuid('lost_found_item_id'),
  agentVisitId: uuid('agent_visit_id'),
  ticketMessageId: uuid('ticket_message_id'),
  sortOrder: smallint('sort_order').notNull().default(0),
  caption: text('caption'),
  ...auditColumns(),
});

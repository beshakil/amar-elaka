import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
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
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz, xid8 } from './columns';
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
  // ThumbHash placeholder (base64), written by the media worker (0019).
  thumbhash: text('thumbhash'),
  variants: jsonb('variants')
    .$type<Record<string, unknown>>()
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
  showWhatsapp: boolean('show_whatsapp').notNull().default(false),
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
  expiryReminderFor: timestamptz('expiry_reminder_for'),
  bumpedAt: timestamptz('bumped_at'),
  creditsCharged: integer('credits_charged').notNull().default(0),
  viewCount: integer('view_count').notNull().default(0),
  // saved_posts rows, kept by trigger (0032).
  savedCount: integer('saved_count').notNull().default(0),
  // Attached photos, kept by the media_attachments_post_photo_count trigger (0030).
  photoCount: smallint('photo_count').notNull().default(0),
  // Non-empty keys of fields, kept by posts_a_maintain_filled_field_count (0030).
  filledFieldCount: smallint('filled_field_count').notNull().default(0),
  searchSyncedAt: timestamptz('search_synced_at'),
  hiddenByOwner: boolean('hidden_by_owner').notNull().default(false),
  // 0050: its store is not active (suspended, closed, deleted); kept by
  // posts_c_maintain_store_hidden and stores_propagate_hidden.
  storeHidden: boolean('store_hidden').notNull().default(false),
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
  // 0043: name_bn in Latin letters, for duplicate detection.
  nameTranslit: text('name_translit'),
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
  // Composite FKs (0042): (tenant_id, claim_store_id) -> stores and
  // (tenant_id, street_photo_media_id) -> media_assets, both SET NULL.
  claimStoreId: uuid('claim_store_id'),
  streetPhotoMediaId: uuid('street_photo_media_id'),
  // 0043: a merged place stays as a redirect; composite FK (tenant_id,
  // merged_into_place_id) -> places, SET NULL.
  mergedIntoPlaceId: uuid('merged_into_place_id'),
  mergedAt: timestamptz('merged_at'),
  // 0044: the owner's "closed today" toggle.
  closedUntil: timestamptz('closed_until'),
  // 0046: flagged by enough "closed permanently" reports; a moderator decides.
  possiblyClosedAt: timestamptz('possibly_closed_at'),
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
  // 0042: the evidence offered (≥ 1), the OTP proof, the store the approval
  // created or linked (composite FK -> stores, SET NULL), a moderator's note.
  evidenceCodes: text('evidence_codes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  otpVerifiedPhoneE164: text('otp_verified_phone_e164'),
  otpVerifiedAt: timestamptz('otp_verified_at'),
  storeId: uuid('store_id'),
  reviewNote: text('review_note'),
  ...auditColumns(),
});

/**
 * 0042 A place's edit history: one row per place per transaction, written by
 * the places trigger and record_place_hours_revision(), never by the API.
 */
export const placeRevisions = pgTable('place_revisions', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FKs (tenant_id, place_id) -> places and (tenant_id,
  // reverts_revision_id) -> place_revisions, both CASCADE.
  placeId: uuid('place_id').notNull(),
  changedFields: jsonb('changed_fields')
    .$type<Record<string, { from: unknown; to: unknown }>>()
    .notNull(),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  kindCode: text('kind_code').notNull(),
  revertsRevisionId: uuid('reverts_revision_id'),
  xactId: xid8('xact_id').notNull(),
  ...auditColumns(),
});

/**
 * 0046 A member's proposed location / phones / weekly hours for a place,
 * pending until a moderator approves (applied through the normal edit path)
 * or rejects it. Filed by suggest_place_edit(), never inserted directly.
 */
export const placeEditSuggestions = pgTable('place_edit_suggestions', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FKs (tenant_id, place_id) -> places CASCADE and
  // (tenant_id, suggester_member_id) -> tenant_members RESTRICT.
  placeId: uuid('place_id').notNull(),
  suggesterMemberId: uuid('suggester_member_id').notNull(),
  changes: jsonb('changes').$type<Record<string, unknown>>().notNull(),
  currentValues: jsonb('current_values')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  note: text('note'),
  statusCode: text('status_code').notNull().default('pending'),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  decidedAt: timestamptz('decided_at'),
  decisionReasonCode: text('decision_reason_code').references(() => moderationReasons.code, {
    onDelete: 'restrict',
  }),
  decisionNote: text('decision_note'),
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
 * One share code per post (0031, ADR 036): `/s/:code` links. Codes are unique
 * across tenants; resolve_short_link() finds the post before any tenant
 * context exists.
 */
export const postShortLinks = pgTable('post_short_links', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, post_id) -> posts, CASCADE.
  postId: uuid('post_id').notNull(),
  code: text('code').notNull(),
  ...auditColumns(),
});

/**
 * §4.7 / §13.29 (0032): a user's saved place. Tenant-scoped in the place's
 * tenant; the user reads their own rows in any tenant context.
 */
export const savedPlaces = pgTable('saved_places', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Composite FK (tenant_id, place_id) -> places, RESTRICT.
  placeId: uuid('place_id').notNull(),
  ...auditColumns(),
});

/** §13.29 (0032): a user's saved store, as saved_places. Following is store_follows. */
export const savedStores = pgTable('saved_stores', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id').notNull(),
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

/**
 * 0043 The duplicate review queue: a likely/possible pair of places or of
 * stores, one row per pair ever. Composite FKs to places/stores stay in SQL.
 */
export const duplicateCandidates = pgTable('duplicate_candidates', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  entityTypeCode: text('entity_type_code').notNull(),
  placeId: uuid('place_id'),
  candidatePlaceId: uuid('candidate_place_id'),
  storeId: uuid('store_id'),
  candidateStoreId: uuid('candidate_store_id'),
  candidateTenantId: uuid('candidate_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  score: numeric('score', { precision: 4, scale: 3 }).notNull(),
  classificationCode: text('classification_code').notNull(),
  signals: jsonb('signals')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  sourceCode: text('source_code').notNull(),
  statusCode: text('status_code').notNull().default('open'),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  resolvedAt: timestamptz('resolved_at'),
  ...auditColumns(),
});

/** 0043 What one place merge moved, for its undo (written only by merge_place()). */
export const placeMerges = pgTable('place_merges', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FKs (tenant_id, loser/target_place_id) -> places, CASCADE.
  loserPlaceId: uuid('loser_place_id').notNull(),
  targetPlaceId: uuid('target_place_id').notNull(),
  mergedByUserId: uuid('merged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => moderationReasons.code, { onDelete: 'restrict' }),
  reasonText: text('reason_text'),
  moved: jsonb('moved').$type<Record<string, unknown>>().notNull(),
  undoUntil: timestamptz('undo_until').notNull(),
  undoneAt: timestamptz('undone_at'),
  undoneByUserId: uuid('undone_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...auditColumns(),
});

/**
 * 0044 Special days of a place or a store, by local date: closed all day, or
 * that day's own range. Composite FKs to places/stores stay in SQL.
 */
export const hoursExceptions = pgTable('hours_exceptions', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  placeId: uuid('place_id'),
  storeId: uuid('store_id'),
  onDate: date('on_date').notNull(),
  isClosed: boolean('is_closed').notNull(),
  opensAt: time('opens_at'),
  closesAt: time('closes_at'),
  closesNextDay: boolean('closes_next_day').notNull().default(false),
  note: text('note'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...auditColumns(),
});

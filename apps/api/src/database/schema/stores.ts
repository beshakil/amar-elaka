import { boolean, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz } from './columns';
import { subscriptionPlans } from './commerce';
import { sellerTypes, sellerVerificationLevels, storeMemberRoles, storeStatuses } from './enums';
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
  isVerified: boolean('is_verified').notNull().default(false),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
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
  roleCode: text('role_code')
    .notNull()
    .default('staff')
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

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  uuid,
} from 'drizzle-orm/pg-core';
import { geoAreas } from './catalog';
import { auditColumns, geographyPoint, id, softDeleteColumns, timestamptz } from './columns';
import {
  bloodGroups,
  bloodRequestStatuses,
  commodityGroups,
  contactMethods,
  donorContactPreferences,
  donorResponseStatuses,
  emergencyServiceTypes,
  lostFoundItemTypes,
  lostFoundKinds,
  lostFoundStatuses,
  marketTypes,
  measurementUnits,
  noticeStatuses,
  noticeTypes,
  priceSources,
  priceStatuses,
  routeDirections,
  transportModes,
  urgencyLevels,
} from './enums';
import { users } from './identity';
import { tenants } from './tenancy';

// ---- bazar_commodities (§10.1): GLOBAL -------------------------------------

export const bazarCommodities = pgTable('bazar_commodities', {
  id: id(),
  code: text('code').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  groupCode: text('group_code')
    .notNull()
    .references(() => commodityGroups.code, { onDelete: 'restrict' }),
  defaultUnitCode: text('default_unit_code')
    .notNull()
    .references(() => measurementUnits.code, { onDelete: 'restrict' }),
  aliases: text('aliases')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  iconKey: text('icon_key'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

// ---- bazar_markets (§10.2): TENANT-SCOPED ----------------------------------

export const bazarMarkets = pgTable('bazar_markets', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  marketTypeCode: text('market_type_code')
    .notNull()
    .references(() => marketTypes.code, { onDelete: 'restrict' }),
  haatDays: smallint('haat_days').array(),
  // Composite FK (tenant_id, locality_id) -> localities, SET NULL.
  localityId: uuid('locality_id'),
  // Composite FK (tenant_id, place_id) -> places, SET NULL.
  placeId: uuid('place_id'),
  location: geographyPoint('location'),
  isActive: boolean('is_active').notNull().default(true),
  ...softDeleteColumns(),
});

// ---- bazar_prices (§10.3): TENANT-SCOPED -----------------------------------

export const bazarPrices = pgTable('bazar_prices', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  commodityId: uuid('commodity_id')
    .notNull()
    .references(() => bazarCommodities.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, bazar_market_id) -> bazar_markets, RESTRICT.
  bazarMarketId: uuid('bazar_market_id'),
  priceDate: date('price_date').notNull(),
  unitCode: text('unit_code')
    .notNull()
    .references(() => measurementUnits.code, { onDelete: 'restrict' }),
  minPrice: numeric('min_price', { precision: 12, scale: 2 }).notNull(),
  maxPrice: numeric('max_price', { precision: 12, scale: 2 }).notNull(),
  qualityNote: text('quality_note'),
  sourceCode: text('source_code')
    .notNull()
    .references(() => priceSources.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, reported_by_member_id) -> tenant_members, SET NULL.
  reportedByMemberId: uuid('reported_by_member_id'),
  statusCode: text('status_code')
    .notNull()
    .default('submitted')
    .references(() => priceStatuses.code, { onDelete: 'restrict' }),
  publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  ...auditColumns(),
});

// ---- blood_donors (§10.4): TENANT-SCOPED -----------------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, member_id) -> tenant_members FK, which stays bare.

export const bloodDonors = pgTable('blood_donors', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, member_id) -> tenant_members, CASCADE.
  memberId: uuid('member_id').notNull(),
  bloodGroupCode: text('blood_group_code')
    .notNull()
    .references(() => bloodGroups.code, { onDelete: 'restrict' }),
  lastDonatedOn: date('last_donated_on'),
  eligibleFrom: date('eligible_from'),
  isAvailable: boolean('is_available').notNull().default(true),
  contactPreferenceCode: text('contact_preference_code')
    .notNull()
    .default('in_app_only')
    .references(() => donorContactPreferences.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, locality_id) -> localities, SET NULL.
  localityId: uuid('locality_id'),
  approxLocation: geographyPoint('approx_location'),
  eligibilityConfirmedAt: timestamptz('eligibility_confirmed_at').notNull(),
  ...softDeleteColumns(),
});

// ---- blood_requests (§10.5): TENANT-SCOPED ---------------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, requester_member_id) -> tenant_members FK.

export const bloodRequests = pgTable('blood_requests', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, requester_member_id) -> tenant_members, RESTRICT.
  requesterMemberId: uuid('requester_member_id').notNull(),
  bloodGroupCode: text('blood_group_code')
    .notNull()
    .references(() => bloodGroups.code, { onDelete: 'restrict' }),
  unitsNeeded: smallint('units_needed').notNull().default(1),
  hospitalName: text('hospital_name').notNull(),
  // Composite FK (tenant_id, hospital_place_id) -> places, SET NULL.
  hospitalPlaceId: uuid('hospital_place_id'),
  patientNote: text('patient_note'),
  contactPhoneE164: text('contact_phone_e164').notNull(),
  neededBy: timestamptz('needed_by').notNull(),
  urgencyCode: text('urgency_code')
    .notNull()
    .references(() => urgencyLevels.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('open')
    .references(() => bloodRequestStatuses.code, { onDelete: 'restrict' }),
  fulfilledAt: timestamptz('fulfilled_at'),
  ...softDeleteColumns(),
});

// ---- blood_request_responses (§10.6): TENANT-SCOPED ------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// two composite FKs below, which stay bare.

export const bloodRequestResponses = pgTable('blood_request_responses', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, blood_request_id) -> blood_requests, CASCADE.
  bloodRequestId: uuid('blood_request_id').notNull(),
  // Composite FK (tenant_id, blood_donor_id) -> blood_donors, CASCADE.
  bloodDonorId: uuid('blood_donor_id').notNull(),
  statusCode: text('status_code')
    .notNull()
    .default('offered')
    .references(() => donorResponseStatuses.code, { onDelete: 'restrict' }),
  donatedAt: timestamptz('donated_at'),
  ...auditColumns(),
});

// ---- national_hotlines (§10.7): GLOBAL -------------------------------------

export const nationalHotlines = pgTable('national_hotlines', {
  id: id(),
  serviceTypeCode: text('service_type_code')
    .notNull()
    .references(() => emergencyServiceTypes.code, { onDelete: 'restrict' }),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  dialString: text('dial_string').notNull(),
  descriptionBn: text('description_bn'),
  descriptionEn: text('description_en'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

// ---- emergency_contacts (§10.8): TENANT-SCOPED -----------------------------

export const emergencyContacts = pgTable('emergency_contacts', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  serviceTypeCode: text('service_type_code')
    .notNull()
    .references(() => emergencyServiceTypes.code, { onDelete: 'restrict' }),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  phones: text('phones').array().notNull(),
  addressText: text('address_text'),
  location: geographyPoint('location'),
  // Composite FK (tenant_id, place_id) -> places, SET NULL.
  placeId: uuid('place_id'),
  is24h: boolean('is_24h').notNull().default(false),
  availabilityNote: text('availability_note'),
  lastVerifiedAt: timestamptz('last_verified_at'),
  verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...softDeleteColumns(),
});

// ---- notices (§10.9): TENANT-SCOPED ----------------------------------------

export const notices = pgTable('notices', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  noticeTypeCode: text('notice_type_code')
    .notNull()
    .references(() => noticeTypes.code, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  contentLocale: text('content_locale').notNull().default('bn'),
  issuerName: text('issuer_name'),
  isOfficial: boolean('is_official').notNull().default(false),
  // Composite FK (tenant_id, published_by_member_id) -> tenant_members, RESTRICT.
  publishedByMemberId: uuid('published_by_member_id').notNull(),
  geoAreaId: uuid('geo_area_id').references(() => geoAreas.id, { onDelete: 'restrict' }),
  eventStartsAt: timestamptz('event_starts_at'),
  eventEndsAt: timestamptz('event_ends_at'),
  expiresAt: timestamptz('expires_at'),
  isPinned: boolean('is_pinned').notNull().default(false),
  statusCode: text('status_code')
    .notNull()
    .default('pending_review')
    .references(() => noticeStatuses.code, { onDelete: 'restrict' }),
  publishedAt: timestamptz('published_at'),
  ...softDeleteColumns(),
});

// ---- transport_routes (§10.10): TENANT-SCOPED ------------------------------

export const transportRoutes = pgTable('transport_routes', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  modeCode: text('mode_code')
    .notNull()
    .references(() => transportModes.code, { onDelete: 'restrict' }),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  operatorName: text('operator_name'),
  originName: text('origin_name').notNull(),
  destinationName: text('destination_name').notNull(),
  originLocation: geographyPoint('origin_location'),
  destinationLocation: geographyPoint('destination_location'),
  typicalDurationMinutes: integer('typical_duration_minutes'),
  fareMin: numeric('fare_min', { precision: 12, scale: 2 }),
  fareMax: numeric('fare_max', { precision: 12, scale: 2 }),
  fareUpdatedOn: date('fare_updated_on'),
  contactPhones: text('contact_phones')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  notes: text('notes'),
  lastVerifiedAt: timestamptz('last_verified_at'),
  isActive: boolean('is_active').notNull().default(true),
  ...softDeleteColumns(),
});

// ---- transport_route_stops (§10.11): TENANT-SCOPED -------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, transport_route_id) -> transport_routes FK.

export const transportRouteStops = pgTable('transport_route_stops', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, transport_route_id) -> transport_routes, CASCADE.
  transportRouteId: uuid('transport_route_id').notNull(),
  seq: smallint('seq').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  location: geographyPoint('location'),
  minutesFromOrigin: integer('minutes_from_origin'),
  fareFromOrigin: numeric('fare_from_origin', { precision: 12, scale: 2 }),
  ...auditColumns(),
});

// ---- transport_schedules (§10.12): TENANT-SCOPED ---------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (tenant_id, transport_route_id) -> transport_routes FK.

export const transportSchedules = pgTable('transport_schedules', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (tenant_id, transport_route_id) -> transport_routes, CASCADE.
  transportRouteId: uuid('transport_route_id').notNull(),
  directionCode: text('direction_code')
    .notNull()
    .default('outbound')
    .references(() => routeDirections.code, { onDelete: 'restrict' }),
  departureTime: time('departure_time').notNull(),
  isoDaysOfWeek: smallint('iso_days_of_week')
    .array()
    .notNull()
    .default(sql`'{1,2,3,4,5,6,7}'::smallint[]`),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  serviceClass: text('service_class'),
  fare: numeric('fare', { precision: 12, scale: 2 }),
  notes: text('notes'),
  ...auditColumns(),
});

// ---- lost_found_items (§10.13): TENANT-SCOPED ------------------------------

export const lostFoundItems = pgTable('lost_found_items', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  kindCode: text('kind_code')
    .notNull()
    .references(() => lostFoundKinds.code, { onDelete: 'restrict' }),
  itemTypeCode: text('item_type_code')
    .notNull()
    .references(() => lostFoundItemTypes.code, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  description: text('description'),
  occurredOn: date('occurred_on'),
  locationText: text('location_text'),
  // Composite FK (tenant_id, locality_id) -> localities, SET NULL.
  localityId: uuid('locality_id'),
  location: geographyPoint('location'),
  // Composite FK (tenant_id, reporter_member_id) -> tenant_members, RESTRICT.
  reporterMemberId: uuid('reporter_member_id').notNull(),
  contactViaCode: text('contact_via_code')
    .notNull()
    .default('chat')
    .references(() => contactMethods.code, { onDelete: 'restrict' }),
  contactPhoneE164: text('contact_phone_e164'),
  rewardAmount: numeric('reward_amount', { precision: 12, scale: 2 }),
  isSensitive: boolean('is_sensitive').notNull().default(false),
  statusCode: text('status_code')
    .notNull()
    .default('pending_review')
    .references(() => lostFoundStatuses.code, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, matched_item_id) -> lost_found_items (self), SET NULL.
  matchedItemId: uuid('matched_item_id'),
  resolvedAt: timestamptz('resolved_at'),
  resolutionNote: text('resolution_note'),
  expiresAt: timestamptz('expires_at'),
  ...softDeleteColumns(),
});

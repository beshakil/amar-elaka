import { sql } from 'drizzle-orm';
import { boolean, date, inet, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id, softDeleteColumns, timestamptz, xid8 } from './columns';
import {
  appealChannels,
  appealQueues,
  appealStatuses,
  banReasons,
  banSeverities,
  banStatuses,
  blacklistReasons,
  blacklistSeverities,
  blacklistStatuses,
  businessVerificationTypes,
  moderationActionTypes,
  moderationReasons,
  reportReasons,
  reportResolutions,
  reportStatuses,
  reviewStatuses,
  trustBands,
  verificationRejectionReasons,
  verificationStatuses,
  verificationTypes,
} from './enums';
import { users } from './identity';
import { legalHolds } from './operations';
import { tenants } from './tenancy';

export interface EvidenceRef {
  type: string;
  id: string;
}

/** §9.6 Platform-wide flag on a person or identifier known for fraud. */
export const blacklistEntries = pgTable('blacklist_entries', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
  phoneE164: text('phone_e164'),
  documentNumberHash: text('document_number_hash'),
  deviceFingerprintHash: text('device_fingerprint_hash'),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => blacklistReasons.code, { onDelete: 'restrict' }),
  severityCode: text('severity_code')
    .notNull()
    .references(() => blacklistSeverities.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('recommended')
    .references(() => blacklistStatuses.code, { onDelete: 'restrict' }),
  summary: text('summary').notNull(),
  sourceTenantId: uuid('source_tenant_id').references(() => tenants.id, {
    onDelete: 'restrict',
  }),
  // Composite FK (source_tenant_id, source_report_id) -> reports, SET NULL (0010).
  sourceReportId: uuid('source_report_id'),
  recommendedByUserId: uuid('recommended_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  evidenceRefs: jsonb('evidence_refs')
    .$type<EvidenceRef[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  reviewedAt: timestamptz('reviewed_at'),
  expiresAt: timestamptz('expires_at'),
  revokedAt: timestamptz('revoked_at'),
  revokeReason: text('revoke_reason'),
  ...auditColumns(),
});

// ---- reviews (§9.1): TENANT-SCOPED ------------------------------------------

export const reviews = pgTable('reviews', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, reviewer_member_id) -> tenant_members, RESTRICT.
  reviewerMemberId: uuid('reviewer_member_id').notNull(),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, place_id) -> places, RESTRICT.
  placeId: uuid('place_id'),
  // Composite FK (tenant_id, seller_member_id) -> tenant_members, RESTRICT.
  sellerMemberId: uuid('seller_member_id'),
  // Composite FK (tenant_id, post_id) -> posts, SET NULL.
  postId: uuid('post_id'),
  rating: smallint('rating').notNull(),
  body: text('body'),
  hasVerifiedInteraction: boolean('has_verified_interaction').notNull().default(false),
  statusCode: text('status_code')
    .notNull()
    .default('published')
    .references(() => reviewStatuses.code, { onDelete: 'restrict' }),
  moderatedByUserId: uuid('moderated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  moderatedAt: timestamptz('moderated_at'),
  moderationReasonCode: text('moderation_reason_code').references(() => moderationReasons.code, {
    onDelete: 'restrict',
  }),
  ...softDeleteColumns(),
});

// ---- review_responses (§9.2): TENANT-SCOPED --------------------------------

export const reviewResponses = pgTable('review_responses', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, review_id) -> reviews, CASCADE.
  reviewId: uuid('review_id').notNull(),
  // Composite FK (tenant_id, responder_member_id) -> tenant_members, RESTRICT.
  responderMemberId: uuid('responder_member_id').notNull(),
  body: text('body').notNull(),
  statusCode: text('status_code')
    .notNull()
    .default('published')
    .references(() => reviewStatuses.code, { onDelete: 'restrict' }),
  ...softDeleteColumns(),
});

// ---- verification_requests (§9.3): GLOBAL ----------------------------------

export const verificationRequests = pgTable('verification_requests', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  typeCode: text('type_code')
    .notNull()
    .references(() => verificationTypes.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('submitted')
    .references(() => verificationStatuses.code, { onDelete: 'restrict' }),
  documentNumberHash: text('document_number_hash'),
  documentNumberLast4: text('document_number_last4'),
  nameOnDocument: text('name_on_document'),
  dateOfBirth: date('date_of_birth'),
  documentStorageKeys: text('document_storage_keys')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  collectedInTenantId: uuid('collected_in_tenant_id').references(() => tenants.id, {
    onDelete: 'restrict',
  }),
  collectedByUserId: uuid('collected_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  providerCode: text('provider_code'),
  providerReference: text('provider_reference'),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  reviewedAt: timestamptz('reviewed_at'),
  rejectionReasonCode: text('rejection_reason_code').references(
    () => verificationRejectionReasons.code,
    {
      onDelete: 'restrict',
    },
  ),
  expiresAt: timestamptz('expires_at'),
  documentsPurgedAt: timestamptz('documents_purged_at'),
  ...auditColumns(),
});

// ---- business_verifications (§9.4): TENANT-SCOPED --------------------------

export const businessVerifications = pgTable('business_verifications', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, place_id) -> places, RESTRICT.
  placeId: uuid('place_id'),
  typeCode: text('type_code')
    .notNull()
    .references(() => businessVerificationTypes.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('submitted')
    .references(() => verificationStatuses.code, { onDelete: 'restrict' }),
  documentNumber: text('document_number'),
  issuingAuthority: text('issuing_authority'),
  validUntil: date('valid_until'),
  // Composite FK (tenant_id, agent_visit_id) -> agent_visits, SET NULL (0012).
  agentVisitId: uuid('agent_visit_id'),
  // Composite FK (tenant_id, submitted_by_member_id) -> tenant_members, RESTRICT.
  submittedByMemberId: uuid('submitted_by_member_id').notNull(),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  reviewedAt: timestamptz('reviewed_at'),
  rejectionReasonCode: text('rejection_reason_code').references(
    () => verificationRejectionReasons.code,
    {
      onDelete: 'restrict',
    },
  ),
  ...auditColumns(),
});

// ---- reports (§9.5): TENANT-SCOPED ------------------------------------------
// lost_found_item_id/notice_id/blood_request_id are deferred (0011).

export const reports = pgTable('reports', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, reporter_member_id) -> tenant_members, RESTRICT.
  reporterMemberId: uuid('reporter_member_id').notNull(),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT.
  postId: uuid('post_id'),
  // Composite FK (tenant_id, store_id) -> stores, RESTRICT.
  storeId: uuid('store_id'),
  // Composite FK (tenant_id, place_id) -> places, RESTRICT.
  placeId: uuid('place_id'),
  // Composite FK (tenant_id, reported_member_id) -> tenant_members, RESTRICT.
  reportedMemberId: uuid('reported_member_id'),
  // Composite FK (tenant_id, message_id) -> messages, RESTRICT.
  messageId: uuid('message_id'),
  // Composite FK (tenant_id, review_id) -> reviews, RESTRICT.
  reviewId: uuid('review_id'),
  // Composite FK (tenant_id, lost_found_item_id) -> lost_found_items, RESTRICT (0011).
  lostFoundItemId: uuid('lost_found_item_id'),
  // Composite FK (tenant_id, notice_id) -> notices, RESTRICT (0011).
  noticeId: uuid('notice_id'),
  // Composite FK (tenant_id, blood_request_id) -> blood_requests, RESTRICT (0011).
  bloodRequestId: uuid('blood_request_id'),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => reportReasons.code, { onDelete: 'restrict' }),
  details: text('details'),
  statusCode: text('status_code')
    .notNull()
    .default('open')
    .references(() => reportStatuses.code, { onDelete: 'restrict' }),
  priority: smallint('priority').notNull().default(0),
  assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  resolutionCode: text('resolution_code').references(() => reportResolutions.code, {
    onDelete: 'restrict',
  }),
  resolutionNote: text('resolution_note'),
  resolvedAt: timestamptz('resolved_at'),
  escalatedAt: timestamptz('escalated_at'),
  ...auditColumns(),
});

// ---- user_trust_scores (§9.7): GLOBAL, 1:1 with users ----------------------

export const userTrustScores = pgTable('user_trust_scores', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  score: smallint('score').notNull(),
  bandCode: text('band_code')
    .notNull()
    .references(() => trustBands.code, { onDelete: 'restrict' }),
  components: jsonb('components')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  algorithmVersion: smallint('algorithm_version').notNull(),
  computedAt: timestamptz('computed_at').notNull(),
  nextRecomputeAt: timestamptz('next_recompute_at'),
  overrideScore: smallint('override_score'),
  overrideReason: text('override_reason'),
  ...auditColumns(),
});

// ---- bans (§9.8): TENANT-SCOPED ---------------------------------------------
// tenant_id has no direct FK to tenants — validated transitively via the
// composite (user_id, tenant_id) -> tenant_members FK, which stays bare.

export const bans = pgTable('bans', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  // Composite FK (user_id, tenant_id) -> tenant_members, RESTRICT.
  userId: uuid('user_id').notNull(),
  severityCode: text('severity_code')
    .notNull()
    .references(() => banSeverities.code, { onDelete: 'restrict' }),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => banReasons.code, { onDelete: 'restrict' }),
  reasonText: text('reason_text').notNull(),
  evidenceRefs: jsonb('evidence_refs')
    .$type<Record<string, unknown>[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  bannedByUserId: uuid('banned_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  isPermanent: boolean('is_permanent').notNull().default(false),
  startsAt: timestamptz('starts_at').notNull().defaultNow(),
  expiresAt: timestamptz('expires_at'),
  escalationStep: smallint('escalation_step').notNull(),
  ladderOverrideReason: text('ladder_override_reason'),
  // Composite FK (tenant_id, previous_ban_id) -> bans (self), RESTRICT.
  previousBanId: uuid('previous_ban_id'),
  statusCode: text('status_code')
    .notNull()
    .default('active')
    .references(() => banStatuses.code, { onDelete: 'restrict' }),
  revokedAt: timestamptz('revoked_at'),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  revokeReason: text('revoke_reason'),
  ...auditColumns(),
});

// ---- ban_appeals (§9.9): GLOBAL, no tenant_id -------------------------------

export const banAppeals = pgTable('ban_appeals', {
  id: id(),
  publicReference: text('public_reference').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  banId: uuid('ban_id').references(() => bans.id, { onDelete: 'restrict' }),
  blacklistEntryId: uuid('blacklist_entry_id').references(() => blacklistEntries.id, {
    onDelete: 'restrict',
  }),
  channelCode: text('channel_code')
    .notNull()
    .references(() => appealChannels.code, { onDelete: 'restrict' }),
  submittedPhoneE164: text('submitted_phone_e164').notNull(),
  submittedAt: timestamptz('submitted_at').notNull().defaultNow(),
  submittedOn: date('submitted_on').generatedAlwaysAs(
    sql`(((submitted_at AT TIME ZONE 'Asia/Dhaka'))::date)`,
  ),
  statement: text('statement').notNull(),
  attachmentStorageKeys: text('attachment_storage_keys')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  queueCode: text('queue_code')
    .notNull()
    .references(() => appealQueues.code, { onDelete: 'restrict' }),
  statusCode: text('status_code')
    .notNull()
    .default('submitted')
    .references(() => appealStatuses.code, { onDelete: 'restrict' }),
  escalateAt: timestamptz('escalate_at'),
  escalatedAt: timestamptz('escalated_at'),
  assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamptz('decided_at'),
  decisionNote: text('decision_note'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  ...auditColumns(),
});

// ---- moderation_actions (§9.11): TENANT-SCOPED, append-only ---------------

export const moderationActions = pgTable('moderation_actions', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  // Composite FK (tenant_id, post_id) -> posts, RESTRICT.
  postId: uuid('post_id').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  actionCode: text('action_code')
    .notNull()
    .references(() => moderationActionTypes.code, { onDelete: 'restrict' }),
  reasonCode: text('reason_code')
    .notNull()
    .references(() => moderationReasons.code, { onDelete: 'restrict' }),
  reasonText: text('reason_text'),
  evidenceRefs: jsonb('evidence_refs')
    .$type<Record<string, unknown>[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  legalHoldId: uuid('legal_hold_id').references(() => legalHolds.id, { onDelete: 'restrict' }),
  xactId: xid8('xact_id').notNull(),
  ...auditColumns(),
});

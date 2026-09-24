import { boolean, inet, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { auditColumns, id, softDeleteColumns, timestamptz } from './columns';
import { consentTypes, devicePlatforms, platformRoles, userStatuses } from './enums';

/** §2.7 A global person account, identified by phone. */
export const users = pgTable('users', {
  id: id(),
  phoneE164: text('phone_e164').notNull(),
  phoneVerifiedAt: timestamptz('phone_verified_at'),
  email: text('email'),
  emailVerifiedAt: timestamptz('email_verified_at'),
  passwordHash: text('password_hash'),
  googleId: text('google_id'),
  statusCode: text('status_code')
    .notNull()
    .default('active')
    .references(() => userStatuses.code, { onDelete: 'restrict' }),
  platformRoleCode: text('platform_role_code').references(() => platformRoles.code, {
    onDelete: 'restrict',
  }),
  preferredLocale: text('preferred_locale').notNull().default('bn'),
  identityVerifiedAt: timestamptz('identity_verified_at'),
  lastLoginAt: timestamptz('last_login_at'),
  statusChangedAt: timestamptz('status_changed_at'),
  ...softDeleteColumns(),
});

/** §2.8 The public-readable half of a user account (1:1). Split from `users` so RLS can expose it without leaking phone/email. */
export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  avatarStorageKey: text('avatar_storage_key'),
  bio: text('bio'),
  // FK to trust_bands is added by the migration that creates it (0010).
  trustBandCode: text('trust_band_code').notNull().default('new'),
  isIdentityVerified: boolean('is_identity_verified').notNull().default(false),
  ...auditColumns(),
});

/** §2.9 An app install or browser a user has signed in on. */
export const userDevices = pgTable('user_devices', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  platformCode: text('platform_code')
    .notNull()
    .references(() => devicePlatforms.code, { onDelete: 'restrict' }),
  pushToken: text('push_token'),
  appVersion: text('app_version'),
  deviceModel: text('device_model'),
  fingerprintHash: text('fingerprint_hash'),
  lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
  revokedAt: timestamptz('revoked_at'),
  ...auditColumns(),
});

/** §2.10 Hashed refresh tokens with rotation-family tracking. */
export const authRefreshTokens = pgTable('auth_refresh_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => userDevices.id, { onDelete: 'set null' }),
  tokenHash: text('token_hash').notNull(),
  familyId: uuid('family_id').notNull(),
  replacedById: uuid('replaced_by_id').references((): AnyPgColumn => authRefreshTokens.id, {
    onDelete: 'set null',
  }),
  expiresAt: timestamptz('expires_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  createdIp: inet('created_ip'),
  userAgent: text('user_agent'),
  ...auditColumns(),
});

/** §2.12 Append-only record of what a user agreed to, and when. */
export const userConsents = pgTable('user_consents', {
  id: id(),
  // Consent evidence must outlive an account scrub.
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  consentTypeCode: text('consent_type_code')
    .notNull()
    .references(() => consentTypes.code, { onDelete: 'restrict' }),
  documentVersion: text('document_version'),
  granted: boolean('granted').notNull(),
  recordedAt: timestamptz('recorded_at').notNull().defaultNow(),
  collectedByUserId: uuid('collected_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  ...auditColumns(),
});

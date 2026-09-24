import { z } from 'zod';

/**
 * Typed registry of every platform setting (docs/specs/schema.md §2.16).
 *
 * Types only — no defaults and no bounds live here. Defaults are seeded into
 * `platform_settings`, and min/max bounds are stored on each row and enforced
 * by the database (CLAUDE.md hard rule 9). A key added here must ship with its
 * seed row in the same migration.
 */
const wholeNumber = z.number().int().nonnegative();
const decimal = z.number().nonnegative();
// Money is a JSON string with exactly two decimals, never a JSON number (§0.2).
const money = z.string().regex(/^\d+\.\d{2}$/);

export const SETTING_DEFINITIONS = {
  // Tenant lifecycle (§13.30)
  grace_past_due_days: wholeNumber,
  grace_suspended_days: wholeNumber,
  grace_terminated_days: wholeNumber,
  archive_after_days: wholeNumber,
  purge_after_days: wholeNumber,
  credit_refund_window_days: wholeNumber,
  notice_before_invoice_days: wholeNumber,
  notice_before_suspend_days: wholeNumber,
  notice_before_terminate_days: wholeNumber,

  // Media & moderation (§4.1, §13.31)
  media_purge_days: wholeNumber,
  scrub_media_purge_days: wholeNumber,
  auto_hide_report_threshold: wholeNumber,
  message_body_retention_days: wholeNumber,
  kyc_document_retention_days: wholeNumber,
  orphan_media_hours: wholeNumber,

  // Bans & appeals (§9.8, §9.9)
  appeal_escalation_days: wholeNumber,
  appeal_rate_limit_per_day: wholeNumber,
  appeal_max_attachments: wholeNumber,
  ban_escalation_lookback_days: wholeNumber,
  tenant_refund_approval_limit_bdt: money,
  ban_ladder_days: z.array(wholeNumber.nullable()).nonempty(),

  // Saved searches (§8.11)
  saved_search_max_active: wholeNumber,
  saved_search_notify_per_day: wholeNumber,
  saved_search_auto_pause_days: wholeNumber,

  // Boosts & credits (§6, §13.32–13.35)
  boost_slots_per_category: wholeNumber,
  boost_voucher_validity_days: wholeNumber,
  credit_bonus_expiry_days: wholeNumber,
  credit_port_max_km: decimal,
  credit_port_activity_lookback_days: wholeNumber,
  reconciliation_alert_threshold: decimal,
  continuity_subsidy_max_bdt_per_month: money,
  continuity_subsidy_platform_max_bdt_per_month: money,
  credit_refund_sla_days: wholeNumber,
  refund_manual_verification_threshold_bdt: money,

  // Posts, ownership & retention
  post_expiry_days_default: wholeNumber,
  free_posts_per_month: wholeNumber,
  boundary_buffer_km: decimal,
  lead_dedupe_minutes: wholeNumber,
  outbox_processed_retention_days: wholeNumber,
  activity_log_retention_days: wholeNumber,
  lead_event_retention_months: wholeNumber,
  export_link_validity_days: wholeNumber,
  landmark_default_radius_km: decimal,
  blood_donation_interval_days: wholeNumber,
  agent_cash_max_hold_hours: wholeNumber,

  // Auth: phone OTP & password policy (Week 2 auth module)
  otp_code_length: wholeNumber,
  otp_ttl_seconds: wholeNumber,
  otp_max_attempts: wholeNumber,
  otp_resend_cooldown_seconds: wholeNumber,
  otp_max_requests_per_phone_per_day: wholeNumber,
  otp_max_requests_per_ip_per_day: wholeNumber,
  auth_password_min_length: wholeNumber,

  // Profile
  profile_display_name_max_length: wholeNumber,

  // Tenant resolution (tenants/nearby)
  tenant_nearby_max_radius_km: decimal,

  // Storage (apps/api/src/storage)
  media_max_upload_bytes: wholeNumber,
} as const satisfies Record<string, z.ZodTypeAny>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_DEFINITIONS, key);
}

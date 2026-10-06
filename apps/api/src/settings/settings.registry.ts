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
const textArray = z.array(z.string());
const flag = z.boolean();
/**
 * Optional Barikoi reverse-geocode fields a purpose may ask for (ADR 044).
 * Each one is an extra billed call; the base answer already has the English
 * address, area and city, and our own geo_areas give every admin area.
 */
export const REVERSE_FIELDS = [
  'bangla',
  'post_code',
  'address',
  'area',
  'district',
  'sub_district',
  'thana',
  'union',
  'pauroshova',
  'division',
  'country',
  'location_type',
] as const;
const reverseFields = z.array(z.enum(REVERSE_FIELDS));
/** The map's layers (ADR 045, GET /map/features). */
export const MAP_LAYERS = ['posts', 'stores', 'places', 'landmarks', 'info'] as const;

/** Where a map kind's features come from (map_kinds, migration 0041). */
export const MAP_KIND_SOURCE_TABLES = [
  'posts',
  'stores',
  'places',
  'emergency',
  'bus_stops',
] as const;
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const code = z.string().regex(/^[a-z][a-z0-9_]*$/);
export const mapKindSchema = z.object({
  code,
  /** An icon key the clients know (hospital, pharmacy, food, gas, bank, bus, shop, listing…). */
  icon: code,
  label_bn: z.string().min(1),
  label_en: z.string().min(1),
  sources: z
    .array(
      z.object({
        table: z.enum(MAP_KIND_SOURCE_TABLES),
        categories: z.array(slug).optional(),
        service_types: z.array(code).optional(),
      }),
    )
    .nonempty(),
});
export type MapKind = z.infer<typeof mapKindSchema>;

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
  // Saved searches and unmet demand (ADR 041, migration 0035)
  saved_search_match_grace_seconds: wholeNumber,
  saved_search_daily_digest_hour: wholeNumber,
  saved_search_new_results_max: wholeNumber,
  saved_search_name_max_length: wholeNumber,
  unmet_demand_result_threshold: wholeNumber,
  unmet_demand_window_days: wholeNumber,
  search_log_origin_decimals: wholeNumber,

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
  place_reverify_after_days: wholeNumber,
  blood_donation_interval_days: wholeNumber,
  agent_cash_max_hold_hours: wholeNumber,
  // Read by the agent_visits_lock_after_edit_window trigger (0012), not by TS.
  agent_visit_edit_window_hours: wholeNumber,

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

  // Posts module (migration 0026)
  post_max_media: wholeNumber,
  post_max_active_per_user: wholeNumber,
  post_max_per_day_per_user: wholeNumber,
  post_rereview_fields: textArray,
  post_title_max_length: wholeNumber,
  post_description_max_length: wholeNumber,
  post_idempotency_ttl_hours: wholeNumber,
  post_list_page_size_default: wholeNumber,
  post_list_page_size_max: wholeNumber,

  // Trust-based moderation (migration 0027, ADR 030)
  trust_base_score: wholeNumber,
  trust_points_per_approved_post: wholeNumber,
  trust_max_approved_points: wholeNumber,
  trust_penalty_per_rejected_post: wholeNumber,
  trust_penalty_per_removed_post: wholeNumber,
  trust_penalty_per_upheld_report: wholeNumber,
  trust_points_per_account_month: wholeNumber,
  trust_max_account_age_points: wholeNumber,
  trust_points_phone_verified: wholeNumber,
  trust_points_store_verified: wholeNumber,
  trust_penalty_per_ban: wholeNumber,
  trust_auto_approve_threshold: wholeNumber,
  moderation_sample_rate_percent: wholeNumber,
  moderation_banned_keywords: textArray,
  moderation_max_links_per_post: wholeNumber,
  moderation_duplicate_window_hours: wholeNumber,
  moderation_price_outlier_factor: decimal,
  moderation_price_min_samples: wholeNumber,
  moderation_price_lookback_days: wholeNumber,
  moderation_bulk_max: wholeNumber,
  moderation_queue_page_size_default: wholeNumber,
  moderation_queue_page_size_max: wholeNumber,
  moderation_typical_review_hours: wholeNumber,

  // Scheduled post-lifecycle jobs (ADR 031)
  post_expiry_reminder_days: wholeNumber,
  draft_retention_days: wholeNumber,
  job_batch_size: wholeNumber,
  job_max_batches_per_run: wholeNumber,
  job_run_stale_minutes: wholeNumber,
  job_run_retention_days: wholeNumber,
  job_runs_page_size: wholeNumber,

  // Tenant resolution (tenants/nearby)
  tenant_nearby_max_radius_km: decimal,

  // Storage and media pipeline (apps/api/src/storage, apps/api/src/media)
  media_max_upload_bytes: wholeNumber,
  media_uploads_per_hour: wholeNumber,
  media_uploads_per_day: wholeNumber,
  media_upload_bytes_per_day: wholeNumber,
  media_max_input_pixels: wholeNumber,
  media_variant_thumb_px: wholeNumber,
  media_variant_card_px: wholeNumber,
  media_variant_full_px: wholeNumber,
  media_image_quality: wholeNumber,

  // Search (ADR 025, migration 0020)
  search_default_radius_km: wholeNumber,
  search_max_radius_km: wholeNumber,
  search_page_size_default: wholeNumber,
  search_page_size_max: wholeNumber,
  search_max_total_hits: wholeNumber,
  search_facet_values_max: wholeNumber,
  search_suggest_limit: wholeNumber,
  search_suggest_min_chars: wholeNumber,
  search_typo_one_typo_min_chars: wholeNumber,
  search_typo_two_typos_min_chars: wholeNumber,
  search_outbox_max_attempts: wholeNumber,

  // Search API (ADR 040, migration 0034)
  trending_window_hours: wholeNumber,
  search_trending_min_searchers: wholeNumber,
  search_trending_limit: wholeNumber,
  search_list_cache_seconds: wholeNumber,
  search_popular_window_days: wholeNumber,
  search_popular_pool_size: wholeNumber,
  search_suggest_listings_max: wholeNumber,
  search_suggest_queries_max: wholeNumber,
  search_suggest_categories_max: wholeNumber,
  search_facet_fields_max: wholeNumber,
  search_price_bucket_count: wholeNumber,
  search_landmarks_max: wholeNumber,
  search_click_window_minutes: wholeNumber,
  search_zero_result_report_days: wholeNumber,
  search_zero_result_report_limit: wholeNumber,

  // Locations & geocoding (ADR 026, migration 0021)
  geocode_results_max: wholeNumber,
  geocode_autocomplete_min_chars: wholeNumber,
  map_viewport_max_areas: wholeNumber,
  tenant_service_radius_max_km: decimal,

  // Feed (ADR 035, migration 0030)
  feed_default_radius_km: decimal,
  feed_max_radius_km: decimal,
  feed_page_size_default: wholeNumber,
  feed_page_size_max: wholeNumber,
  feed_weight_distance: decimal,
  feed_weight_recency: decimal,
  feed_weight_boost: decimal,
  feed_weight_trust: decimal,
  feed_weight_completeness: decimal,
  feed_distance_half_km: decimal,
  feed_recency_half_life_hours: wholeNumber,
  feed_completeness_photo_target: wholeNumber,
  feed_store_card_interval: wholeNumber,
  feed_emergency_card_position: wholeNumber,
  feed_bazar_card_position: wholeNumber,
  feed_landmark_card_position: wholeNumber,
  feed_landmark_cards_max: wholeNumber,
  feed_bazar_card_items: wholeNumber,
  feed_emergency_card_items: wholeNumber,
  feed_cache_ttl_seconds: wholeNumber,
  feed_cache_geohash_precision: wholeNumber,

  // Post detail, contacts, views, share, reports (ADR 036, migration 0031)
  view_dedupe_hours: wholeNumber,
  post_similar_max: wholeNumber,
  post_similar_radius_km: decimal,
  contact_reveals_per_user_per_day: wholeNumber,
  require_login_for_contact: flag,
  share_code_length: wholeNumber,
  report_details_max_length: wholeNumber,
  reports_per_user_per_day: wholeNumber,

  // Saved items and store follows (ADR 037, migration 0032)
  saved_page_size_default: wholeNumber,
  saved_page_size_max: wholeNumber,
  store_activity_months_default: wholeNumber,
  store_activity_months_max: wholeNumber,

  // Public web listing pages (ADR 039, migration 0033)
  sold_noindex_days: wholeNumber,
  web_home_revalidate_seconds: wholeNumber,
  web_category_revalidate_seconds: wholeNumber,
  web_listing_revalidate_seconds: wholeNumber,
  sitemap_urls_per_file: wholeNumber,

  // Category + area landing pages (ADR 042, migration 0036)
  seo_area_page_min_listings: wholeNumber,

  // Self-hosted base map (ADR 043, migration 0038)
  map_tiles_max_zoom: wholeNumber,
  map_label_language: z.enum(['bn', 'en']),
  // Empty = disabled. A Barikoi style here costs 4 Barikoi API calls per map load.
  map_style_fallback: z.union([z.literal(''), z.string().url()]),

  // Geo provider (Barikoi) and map viewport (ADR 044, migration 0039)
  geo_provider: z.enum(['barikoi', 'null']),
  barikoi_daily_call_budget: wholeNumber,
  barikoi_budget_warn_pct: wholeNumber,
  barikoi_cost_autocomplete: wholeNumber,
  barikoi_cost_reverse_base: wholeNumber,
  barikoi_cost_reverse_per_field: wholeNumber,
  barikoi_cost_rupantor: wholeNumber,
  barikoi_cost_route: wholeNumber,
  geo_cache_ttl_hours: wholeNumber,
  reverse_geocode_cache_precision: wholeNumber,
  geo_reverse_fields_post_location: reverseFields,
  geo_reverse_fields_store_setup: reverseFields,
  geo_reverse_fields_place_marking: reverseFields,
  geo_own_results_min: wholeNumber,
  geo_own_radius_km: decimal,
  geo_autocomplete_per_client_per_minute: wholeNumber,
  geo_breaker_cooldown_seconds: wholeNumber,
  geo_provider_calls_retention_days: wholeNumber,
  geo_usage_report_days_max: wholeNumber,
  route_point_decimals: wholeNumber,
  route_requests_per_client_per_hour: wholeNumber,
  map_cluster_cell_px: wholeNumber,
  map_cluster_until_zoom: wholeNumber,
  map_viewport_max_radius_km: decimal,
  map_features_max: wholeNumber,
  map_features_cache_seconds: wholeNumber,
  map_layers_default: z.array(z.enum(MAP_LAYERS)).nonempty(),
  // Read by map_features() (0040): place category slugs shown in the info layer.
  map_info_place_categories: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)),

  // The app's Map tab and LocationPicker (ADR 046, migration 0041)
  geo_picker_idle_debounce_ms: wholeNumber,
  geo_autocomplete_debounce_ms: wholeNumber,
  map_search_area_move_ratio: decimal,
  map_pin_label_min_zoom: wholeNumber,
  map_pin_label_max: wholeNumber,
  map_kinds: z
    .array(mapKindSchema)
    .refine(
      (kinds) => new Set(kinds.map((k) => k.code)).size === kinds.length,
      'kind codes are unique',
    ),
} as const satisfies Record<string, z.ZodTypeAny>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_DEFINITIONS, key);
}

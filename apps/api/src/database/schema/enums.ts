import { pgTable } from 'drizzle-orm/pg-core';
import { enumTableColumns } from './columns';

// Enum tables used by migration 0001 (docs/specs/schema.md §12). Codes are
// seeded by the migration; these mirrors exist for typed joins and FKs.
export const tenantStatuses = pgTable('tenant_statuses', enumTableColumns());
export const userStatuses = pgTable('user_statuses', enumTableColumns());
export const platformRoles = pgTable('platform_roles', enumTableColumns());
export const memberRoles = pgTable('member_roles', enumTableColumns());
export const memberStatuses = pgTable('member_statuses', enumTableColumns());
export const moderationModes = pgTable('moderation_modes', enumTableColumns());
export const banSeverities = pgTable('ban_severities', enumTableColumns());
export const blacklistReasons = pgTable('blacklist_reasons', enumTableColumns());
export const blacklistSeverities = pgTable('blacklist_severities', enumTableColumns());
export const blacklistStatuses = pgTable('blacklist_statuses', enumTableColumns());

// Enum tables added by migration 0003 (§12).
export const partnerStatuses = pgTable('partner_statuses', enumTableColumns());
export const payoutMethods = pgTable('payout_methods', enumTableColumns());
export const devicePlatforms = pgTable('device_platforms', enumTableColumns());
export const counterTypes = pgTable('counter_types', enumTableColumns());
export const consentTypes = pgTable('consent_types', enumTableColumns());
export const tenantTransferStatuses = pgTable('tenant_transfer_statuses', enumTableColumns());
export const settingValueTypes = pgTable('setting_value_types', enumTableColumns());
export const settingOverrideScopes = pgTable('setting_override_scopes', enumTableColumns());

// Enum tables added by migration 0004 (§12).
export const geoAreaLevels = pgTable('geo_area_levels', enumTableColumns());
export const categoryKinds = pgTable('category_kinds', enumTableColumns());
export const schemaStatuses = pgTable('schema_statuses', enumTableColumns());

// Enum tables added by migration 0005 (§12).
export const mediaKinds = pgTable('media_kinds', enumTableColumns());
export const mediaVisibilities = pgTable('media_visibilities', enumTableColumns());
export const mediaStatuses = pgTable('media_statuses', enumTableColumns());
export const priceTypes = pgTable('price_types', enumTableColumns());
export const postStatuses = pgTable('post_statuses', enumTableColumns());
export const moderationReasons = pgTable('moderation_reasons', enumTableColumns());
export const postDeletionReasons = pgTable('post_deletion_reasons', enumTableColumns());
export const ownershipResolutions = pgTable('ownership_resolutions', enumTableColumns());
export const placeSources = pgTable('place_sources', enumTableColumns());
export const placeStatuses = pgTable('place_statuses', enumTableColumns());
export const claimVerificationMethods = pgTable('claim_verification_methods', enumTableColumns());
export const claimStatuses = pgTable('claim_statuses', enumTableColumns());

// Enum tables added by migration 0006 (§12).
export const sellerTypes = pgTable('seller_types', enumTableColumns());
export const sellerVerificationLevels = pgTable('seller_verification_levels', enumTableColumns());
export const storeStatuses = pgTable('store_statuses', enumTableColumns());
export const storeMemberRoles = pgTable('store_member_roles', enumTableColumns());

// Enum tables added by migration 0007 (§12).
export const creditReasons = pgTable('credit_reasons', enumTableColumns());
export const creditValuationMethods = pgTable('credit_valuation_methods', enumTableColumns());
export const creditPoolStatuses = pgTable('credit_pool_statuses', enumTableColumns());
export const creditDispositionOutcomes = pgTable('credit_disposition_outcomes', enumTableColumns());
export const portDestinationRules = pgTable('port_destination_rules', enumTableColumns());
export const closureRefundStatuses = pgTable('closure_refund_statuses', enumTableColumns());
export const liabilitySettlementKinds = pgTable('liability_settlement_kinds', enumTableColumns());
export const boostPlacements = pgTable('boost_placements', enumTableColumns());
export const boostTargets = pgTable('boost_targets', enumTableColumns());
export const boostStatuses = pgTable('boost_statuses', enumTableColumns());
export const boostStopReasons = pgTable('boost_stop_reasons', enumTableColumns());
export const subscriptionSubjects = pgTable('subscription_subjects', enumTableColumns());
export const billingIntervals = pgTable('billing_intervals', enumTableColumns());
export const subscriptionStatuses = pgTable('subscription_statuses', enumTableColumns());
export const invoiceStatuses = pgTable('invoice_statuses', enumTableColumns());
export const invoiceLineTypes = pgTable('invoice_line_types', enumTableColumns());
export const revenueStreams = pgTable('revenue_streams', enumTableColumns());
export const adSurfaces = pgTable('ad_surfaces', enumTableColumns());
export const adCreativeStatuses = pgTable('ad_creative_statuses', enumTableColumns());
export const adBookingStatuses = pgTable('ad_booking_statuses', enumTableColumns());

// Enum tables added by migration 0008 (§12).
export const taxInvoiceFormats = pgTable('tax_invoice_formats', enumTableColumns());
export const refundChannels = pgTable('refund_channels', enumTableColumns());
export const tenantClosureTypes = pgTable('tenant_closure_types', enumTableColumns());
export const finalSettlementStatuses = pgTable('final_settlement_statuses', enumTableColumns());
export const paymentProviders = pgTable('payment_providers', enumTableColumns());
export const paymentStatuses = pgTable('payment_statuses', enumTableColumns());
export const paymentEventDirections = pgTable('payment_event_directions', enumTableColumns());
export const refundReasons = pgTable('refund_reasons', enumTableColumns());
export const refundStatuses = pgTable('refund_statuses', enumTableColumns());
export const revenueCalcMethods = pgTable('revenue_calc_methods', enumTableColumns());
export const revenueBases = pgTable('revenue_bases', enumTableColumns());
export const settlementPeriodStatuses = pgTable('settlement_period_statuses', enumTableColumns());
export const settlementStatuses = pgTable('settlement_statuses', enumTableColumns());
export const ledgerAccounts = pgTable('ledger_accounts', enumTableColumns());
export const payoutDirections = pgTable('payout_directions', enumTableColumns());
export const payoutStatuses = pgTable('payout_statuses', enumTableColumns());

// Enum tables added by migration 0009 (§12).
export const conversationKinds = pgTable('conversation_kinds', enumTableColumns());
export const participantRoles = pgTable('participant_roles', enumTableColumns());
export const messageKinds = pgTable('message_kinds', enumTableColumns());
export const notificationTypes = pgTable('notification_types', enumTableColumns());
export const notificationChannels = pgTable('notification_channels', enumTableColumns());
export const deliveryPurposes = pgTable('delivery_purposes', enumTableColumns());
export const deliveryStatuses = pgTable('delivery_statuses', enumTableColumns());
export const leadChannels = pgTable('lead_channels', enumTableColumns());
export const leadSources = pgTable('lead_sources', enumTableColumns());
export const alertFrequencies = pgTable('alert_frequencies', enumTableColumns());

// Enum tables added by migration 0010 (§12).
export const reviewStatuses = pgTable('review_statuses', enumTableColumns());
export const verificationTypes = pgTable('verification_types', enumTableColumns());
export const verificationStatuses = pgTable('verification_statuses', enumTableColumns());
export const verificationRejectionReasons = pgTable(
  'verification_rejection_reasons',
  enumTableColumns(),
);
export const businessVerificationTypes = pgTable('business_verification_types', enumTableColumns());
export const reportReasons = pgTable('report_reasons', enumTableColumns());
export const reportStatuses = pgTable('report_statuses', enumTableColumns());
export const reportResolutions = pgTable('report_resolutions', enumTableColumns());
export const trustBands = pgTable('trust_bands', enumTableColumns());
export const banReasons = pgTable('ban_reasons', enumTableColumns());
export const banStatuses = pgTable('ban_statuses', enumTableColumns());
export const appealChannels = pgTable('appeal_channels', enumTableColumns());
export const appealQueues = pgTable('appeal_queues', enumTableColumns());
export const appealStatuses = pgTable('appeal_statuses', enumTableColumns());
// Grouped under "Content" in spec §12, but first actually used by
// moderation_actions (0010) — see that migration's header.
export const moderationActionTypes = pgTable('moderation_action_types', enumTableColumns());

// Enum tables added by migration 0011 (§12).
export const commodityGroups = pgTable('commodity_groups', enumTableColumns());
export const measurementUnits = pgTable('measurement_units', enumTableColumns());
export const marketTypes = pgTable('market_types', enumTableColumns());
export const priceSources = pgTable('price_sources', enumTableColumns());
export const priceStatuses = pgTable('price_statuses', enumTableColumns());
export const bloodGroups = pgTable('blood_groups', enumTableColumns());
export const donorContactPreferences = pgTable('donor_contact_preferences', enumTableColumns());
export const bloodRequestStatuses = pgTable('blood_request_statuses', enumTableColumns());
export const urgencyLevels = pgTable('urgency_levels', enumTableColumns());
export const donorResponseStatuses = pgTable('donor_response_statuses', enumTableColumns());
export const emergencyServiceTypes = pgTable('emergency_service_types', enumTableColumns());
export const noticeTypes = pgTable('notice_types', enumTableColumns());
export const noticeStatuses = pgTable('notice_statuses', enumTableColumns());
export const transportModes = pgTable('transport_modes', enumTableColumns());
export const routeDirections = pgTable('route_directions', enumTableColumns());
export const lostFoundKinds = pgTable('lost_found_kinds', enumTableColumns());
export const lostFoundItemTypes = pgTable('lost_found_item_types', enumTableColumns());
export const contactMethods = pgTable('contact_methods', enumTableColumns());
export const lostFoundStatuses = pgTable('lost_found_statuses', enumTableColumns());

// Enum tables added by migration 0012 (§12).
export const remittanceMethods = pgTable('remittance_methods', enumTableColumns());
export const remittanceStatuses = pgTable('remittance_statuses', enumTableColumns());
export const legalHoldSubjectTypes = pgTable('legal_hold_subject_types', enumTableColumns());
export const agentEmploymentTypes = pgTable('agent_employment_types', enumTableColumns());
export const agentStatuses = pgTable('agent_statuses', enumTableColumns());
export const visitPurposes = pgTable('visit_purposes', enumTableColumns());
export const visitOutcomes = pgTable('visit_outcomes', enumTableColumns());
export const commissionSources = pgTable('commission_sources', enumTableColumns());
export const commissionStatuses = pgTable('commission_statuses', enumTableColumns());
export const activityEventTypes = pgTable('activity_event_types', enumTableColumns());
export const ticketCategories = pgTable('ticket_categories', enumTableColumns());
export const ticketStatuses = pgTable('ticket_statuses', enumTableColumns());
export const ticketPriorities = pgTable('ticket_priorities', enumTableColumns());

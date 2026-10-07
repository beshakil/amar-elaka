import { TAKEDOWN_REASONS } from '../reasons';

/** The Places tab's sub-queues, in tab order. */
export const PLACE_TABS = ['new', 'claims', 'suggestions', 'duplicates', 'reports'] as const;
export type PlaceTab = (typeof PLACE_TABS)[number];

export function isPlaceTab(value: string | undefined): value is PlaceTab {
  return value !== undefined && (PLACE_TABS as readonly string[]).includes(value);
}

/** Mirrors rejectClaimSchema (apps/api/src/places/dto/places.dto.ts). */
export const CLAIM_REJECT_REASONS = [...TAKEDOWN_REASONS, 'place_already_claimed'] as const;

/** Mirrors SUGGESTION_REJECT_REASONS (apps/api/src/places/dto/place-moderation.dto.ts). */
export const SUGGESTION_REJECT_REASONS = ['suggestion_incorrect', ...TAKEDOWN_REASONS] as const;

/** Mirrors PLACE_REPORT_REASONS. */
export const PLACE_REPORT_REASONS = [
  'wrong_location',
  'closed_permanently',
  'duplicate',
  'wrong_information',
  'inappropriate',
] as const;

/** Mirrors PLACE_REPORT_DECISIONS. */
export const REPORT_DECISIONS = [
  'dismiss',
  'resolved',
  'confirm_closed',
  'clear_closed_flag',
  'unpublish',
] as const;
export type ReportDecision = (typeof REPORT_DECISIONS)[number];

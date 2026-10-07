import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { TAKEDOWN_REASONS } from '../../moderation/dto/moderation.dto';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: ISO weekdays, Monday = 1 … Sunday = 7.
const ISO_DAYS = 7;
// settings-exempt: abuse bound on input size; the per-day limit is hours_ranges_per_day_max.
const MAX_HOURS_RANGES = 28;
// settings-exempt: abuse bound on input size; the real limit is place_max_phones.
const MAX_PHONES_INPUT = 10;

/** report_reasons a place may be reported for (0010 + 0046). */
export const PLACE_REPORT_REASONS = [
  'wrong_location',
  'closed_permanently',
  'duplicate',
  'wrong_information',
  'inappropriate',
] as const;
export type PlaceReportReason = (typeof PLACE_REPORT_REASONS)[number];

/** What a moderator does with a place's open reports. */
export const PLACE_REPORT_DECISIONS = [
  /** Nothing wrong: the open reports are dismissed. */
  'dismiss',
  /** Fixed (edited, merged, moved): the open reports are closed as actioned. */
  'resolved',
  /** It really closed: permanently_closed, every open report actioned. */
  'confirm_closed',
  /** It's still open: the flag goes, the closed reports are dismissed. */
  'clear_closed_flag',
  /** Inappropriate: off the map (rejected), every open report actioned. */
  'unpublish',
] as const;
export type PlaceReportDecision = (typeof PLACE_REPORT_DECISIONS)[number];

export const SUGGESTION_REJECT_REASONS = ['suggestion_incorrect', ...TAKEDOWN_REASONS] as const;

const reasonText = z.string().trim().min(1);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 09:30');
const location = z
  .object({
    lat: z.number().min(-MAX_LAT).max(MAX_LAT),
    lng: z.number().min(-MAX_LNG).max(MAX_LNG),
  })
  .strict();
const hours = z
  .array(
    z.object({ day: z.number().int().min(1).max(ISO_DAYS), opens: clock, closes: clock }).strict(),
  )
  .max(MAX_HOURS_RANGES);

// ---- report ----------------------------------------------------------------

export const reportPlaceSchema = z
  .object({
    reasonCode: z.enum(PLACE_REPORT_REASONS),
    /** Length checked against report_details_max_length in the service (rule 9). */
    text: z.string().trim().optional(),
    /** With `duplicate`: the place this one duplicates (goes to the duplicates queue). */
    duplicateOfPlaceId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.duplicateOfPlaceId === undefined || v.reasonCode === 'duplicate', {
    message: 'duplicateOfPlaceId goes with reasonCode "duplicate".',
    path: ['duplicateOfPlaceId'],
  });
export type ReportPlaceInput = z.infer<typeof reportPlaceSchema>;
export class ReportPlaceDto extends createZodDto(reportPlaceSchema) {}

/** Never says how many others reported or whether the place got flagged. */
export const placeReportResultSchema = z.object({
  reportId: z.string().uuid(),
  /** false: this member's open report on the place already existed. */
  created: z.boolean(),
});
export type PlaceReportResult = z.infer<typeof placeReportResultSchema>;
export class PlaceReportResultDto extends createZodDto(placeReportResultSchema) {}

export const reportQueueQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
    reason: z.enum(PLACE_REPORT_REASONS).optional(),
  })
  .strict();
export type ReportQueueQuery = z.infer<typeof reportQueueQuerySchema>;
export class ReportQueueQueryDto extends createZodDto(reportQueueQuerySchema) {}

export const placeReportQueueItemSchema = z.object({
  placeId: z.string().uuid(),
  nameBn: z.string(),
  nameEn: z.string().nullable(),
  status: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  /** Flagged by closed_permanently reports (place_closed_report_threshold). */
  possiblyClosed: z.boolean(),
  /** Open reports per reason. */
  reasons: z.record(z.number().int()),
  reporterCount: z.number().int(),
  /** The latest few reporters' notes. */
  notes: z.array(z.string()),
  firstReportedAt: z.string().datetime(),
});
export type PlaceReportQueueItem = z.infer<typeof placeReportQueueItemSchema>;
export const placeReportQueueSchema = z.object({
  items: z.array(placeReportQueueItemSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type PlaceReportQueuePage = z.infer<typeof placeReportQueueSchema>;
export class PlaceReportQueueDto extends createZodDto(placeReportQueueSchema) {}

export const placeReportDecisionSchema = z
  .object({
    decision: z.enum(PLACE_REPORT_DECISIONS),
    /** Required with `unpublish`. */
    reasonCode: z.enum(TAKEDOWN_REASONS).optional(),
    reasonText: reasonText.optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'unpublish' || v.reasonCode !== undefined, {
    message: 'Unpublishing needs a reasonCode.',
    path: ['reasonCode'],
  });
export type PlaceReportDecisionInput = z.infer<typeof placeReportDecisionSchema>;
export class PlaceReportDecisionDto extends createZodDto(placeReportDecisionSchema) {}

export const placeReportDecisionResultSchema = z.object({
  placeId: z.string().uuid(),
  decision: z.enum(PLACE_REPORT_DECISIONS),
  status: z.string(),
  possiblyClosed: z.boolean(),
  /** Open reports this decision closed. */
  reportsClosed: z.number().int(),
});
export type PlaceReportDecisionResult = z.infer<typeof placeReportDecisionResultSchema>;
export class PlaceReportDecisionResultDto extends createZodDto(placeReportDecisionResultSchema) {}

// ---- suggestions -----------------------------------------------------------

export const suggestPlaceEditSchema = z
  .object({
    location: location.optional(),
    /** Bangladeshi mobile numbers; normalised to E.164 by the service. */
    phones: z.array(z.string().trim().min(1)).max(MAX_PHONES_INPUT).optional(),
    /** The whole weekly schedule as it should be (a day without an entry is closed). */
    hours: hours.optional(),
    /** Length checked against place_suggestion_note_max_length (rule 9). */
    note: z.string().trim().optional(),
  })
  .strict()
  .refine((v) => v.location !== undefined || v.phones !== undefined || v.hours !== undefined, {
    message: 'Suggest a location, phones or hours.',
  });
export type SuggestPlaceEditInput = z.infer<typeof suggestPlaceEditSchema>;
export class SuggestPlaceEditDto extends createZodDto(suggestPlaceEditSchema) {}

const suggestionChangesSchema = z.object({
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  phones: z.array(z.string()).optional(),
  hours: z.array(z.object({ day: z.number(), opens: z.string(), closes: z.string() })).optional(),
});
export type SuggestionChanges = z.infer<typeof suggestionChangesSchema>;

export const SUGGESTION_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;

export const placeSuggestionSchema = z.object({
  id: z.string().uuid(),
  placeId: z.string().uuid(),
  status: z.enum(SUGGESTION_STATUSES),
  changes: suggestionChangesSchema,
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type PlaceSuggestionView = z.infer<typeof placeSuggestionSchema>;
export class PlaceSuggestionDto extends createZodDto(placeSuggestionSchema) {}

export const suggestionIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class SuggestionIdParamDto extends createZodDto(suggestionIdParamSchema) {}

export const suggestionQueueItemSchema = z.object({
  id: z.string().uuid(),
  placeId: z.string().uuid(),
  placeNameBn: z.string(),
  placeNameEn: z.string().nullable(),
  changes: suggestionChangesSchema,
  /** The place's values for the suggested fields now (it may have changed since). */
  current: suggestionChangesSchema,
  note: z.string().nullable(),
  suggesterMemberId: z.string().uuid(),
  suggesterTrustScore: z.number().int(),
  createdAt: z.string().datetime(),
});
export type SuggestionQueueItem = z.infer<typeof suggestionQueueItemSchema>;
export const suggestionQueueSchema = z.object({
  items: z.array(suggestionQueueItemSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type SuggestionQueuePage = z.infer<typeof suggestionQueueSchema>;
export class SuggestionQueueDto extends createZodDto(suggestionQueueSchema) {}

export const approveSuggestionSchema = z.object({ reasonText: reasonText.optional() }).strict();
export type ApproveSuggestionInput = z.infer<typeof approveSuggestionSchema>;
export class ApproveSuggestionDto extends createZodDto(approveSuggestionSchema) {}

export const rejectSuggestionSchema = z
  .object({ reasonCode: z.enum(SUGGESTION_REJECT_REASONS), reasonText: reasonText.optional() })
  .strict();
export type RejectSuggestionInput = z.infer<typeof rejectSuggestionSchema>;
export class RejectSuggestionDto extends createZodDto(rejectSuggestionSchema) {}

export const suggestionDecisionResultSchema = z.object({
  id: z.string().uuid(),
  placeId: z.string().uuid(),
  status: z.enum(['approved', 'rejected']),
});
export type SuggestionDecisionResult = z.infer<typeof suggestionDecisionResultSchema>;
export class SuggestionDecisionResultDto extends createZodDto(suggestionDecisionResultSchema) {}

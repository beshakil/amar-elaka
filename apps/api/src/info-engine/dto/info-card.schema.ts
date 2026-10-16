import { z } from 'zod';

/**
 * The info engine's one card (ADR 065), on its own: the feed's DTO imports
 * it, and nothing here imports back (info-engine.dto → engagement.dto →
 * feed.dto would be a cycle that leaves the feed's schemas undefined).
 */
export const INFO_TYPES = [
  'outage',
  'outage_report',
  'notice',
  'lost_found',
  'transport',
  'gov_service',
  'directory',
] as const;
export type InfoType = (typeof INFO_TYPES)[number];

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });
const point = z.object({ lat: z.number(), lng: z.number() });

export const infoCardSchema = z.object({
  type: z.enum(INFO_TYPES),
  id: z.string(),
  tenantId: z.string(),
  title: localized,
  summary: z.string().nullable(),
  /** Codes (utility, notice type, mode, category, `ongoing`, `official`, `24h`…) the apps name. */
  badges: z.array(z.string()),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Past the type's stale window (info_stale_days_*): "may be out of date". */
  isStale: z.boolean(),
  distanceMeters: z.number().nullable(),
  location: point.nullable(),
  image: z.object({ url: z.string(), thumbhash: z.string().nullable() }).nullable(),
});
export type InfoCard = z.infer<typeof infoCardSchema>;

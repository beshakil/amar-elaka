import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { CONTACT_CHANNELS } from '../../engagement/dto/engagement.dto';
import { infoCardSchema } from './info-card.schema';

export { INFO_TYPES, infoCardSchema, type InfoCard, type InfoType } from './info-card.schema';

/**
 * The info engine's contract (ADR 065). Every list and every feed card of a
 * local information type is an InfoCard: the same fields, a type, and badge
 * *codes* the clients name in their own strings. Details are per type.
 */

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: generic input-length caps on free text, not business thresholds
const TITLE_MAX = 200;
// settings-exempt: see above
const TEXT_MAX = 5000;
// settings-exempt: see above
const SHORT_MAX = 500;
// settings-exempt: see above
const LIST_MAX = 50;
// settings-exempt: a timetable's ceiling for one save, not a business limit
const SCHEDULE_MAX = 300;
// settings-exempt: validation ceiling; the real limits are notice_attachments_max / lost_found_photos_max
const MEDIA_IDS_CEILING = 20;
// settings-exempt: input sanity floor on a reason text
const REASON_MIN = 3;
// settings-exempt: a plausibility ceiling on an age typed into a notice
const AGE_MAX = 130;
// settings-exempt: ISO weekdays, Monday = 1 … Sunday = 7 (a calendar fact)
const ISO_MONDAY = 1;
// settings-exempt: see above
const ISO_SUNDAY = 7;
// settings-exempt: see above — every day of the week
const EVERY_DAY = Array.from({ length: ISO_SUNDAY }, (_, i) => i + ISO_MONDAY);

export const UTILITIES = ['electricity', 'gas', 'water'] as const;
export const NOTICE_CATEGORIES = ['local', 'community', 'advisory'] as const;
export const NOTICE_TYPES = [
  'government',
  'union_parishad',
  'pourashava',
  'education',
  'religious',
  'community_event',
  'obituary',
  'weather_alert',
] as const;
export const NOTICE_TEMPLATES = ['janaza', 'condolence'] as const;
export const LOST_FOUND_KINDS = ['lost', 'found'] as const;
export const LOST_FOUND_ITEM_TYPES = [
  'phone',
  'wallet',
  'documents',
  'person',
  'pet',
  'livestock',
  'vehicle',
  'bag',
  'jewellery',
  'other',
] as const;
export const TRANSPORT_MODES = [
  'bus',
  'launch',
  'train',
  'cng',
  'cng_stand',
  'auto_rickshaw',
  'leguna',
  'microbus',
  'ferry',
] as const;
export const GOV_CATEGORIES = [
  'identity',
  'certificate',
  'land',
  'license',
  'social_safety',
  'agriculture',
  'education',
  'health',
  'utility',
  'other',
] as const;
/** The directory's kinds and the place categories behind them (ADR 065). */
export const DIRECTORY_KINDS = ['health', 'pharmacy', 'education'] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];
export const MODERATION_DECISIONS = ['approve', 'reject', 'remove'] as const;
/** moderation_reasons a moderator may decide member content for. */
export const MODERATION_REASONS = [
  'meets_guidelines',
  'spam',
  'false_information',
  'privacy_risk',
  'disrespectful',
  'harassment',
  'policy_violation',
  'illegal_content',
] as const;
export const REPORT_REASONS = [
  'false_information',
  'privacy_risk',
  'spam',
  'harassment',
  'other',
] as const;

const uuid = z.string().uuid();
const coordinate = (max: number) => z.coerce.number().min(-max).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-15');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 07:30');
const instant = z.string().datetime({ offset: true });
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'an amount like 45 or 45.50');
const bdMobile = z.string().regex(/^\+8801[3-9]\d{8}$/, 'a BD mobile number like +8801712345678');
const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });
const point = z.object({ lat: z.number(), lng: z.number() });
const pointInput = z.object({ lat: coordinate(MAX_LAT), lng: coordinate(MAX_LNG) });
const text = (max: number) => z.string().trim().max(max);

// ---- the shared card ---------------------------------------------------------

export const infoListSchema = z.object({
  items: z.array(infoCardSchema),
  radiusKm: z.number().nullable(),
  next: z.string().nullable(),
});
export type InfoList = z.infer<typeof infoListSchema>;
export class InfoListDto extends createZodDto(infoListSchema) {}

export const idParamSchema = z.object({ id: uuid }).strict();
export class InfoEngineIdParamDto extends createZodDto(idParamSchema) {}

export const slugParamSchema = z
  .object({ slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/) })
  .strict();
export class SlugParamDto extends createZodDto(slugParamSchema) {}

const origin = {
  lat: coordinate(MAX_LAT).optional(),
  lng: coordinate(MAX_LNG).optional(),
};
const pairedOrigin = (q: { lat?: number | undefined; lng?: number | undefined }) =>
  (q.lat === undefined) === (q.lng === undefined);

export const originOnlySchema = z
  .object(origin)
  .strict()
  .refine(pairedOrigin, 'lat and lng go together');
export type OriginOnly = z.infer<typeof originOnlySchema>;
export class OriginOnlyDto extends createZodDto(originOnlySchema) {}

export const reportSchema = z
  .object({ reasonCode: z.enum(REPORT_REASONS), details: text(SHORT_MAX).nullable().optional() })
  .strict();
export type ReportInput = z.infer<typeof reportSchema>;
export class InfoReportDto extends createZodDto(reportSchema) {}

export const okSchema = z.object({ ok: z.literal(true) });
export class OkDto extends createZodDto(okSchema) {}

export const createdSchema = z.object({ id: z.string(), status: z.string() });
export type Created = z.infer<typeof createdSchema>;
export class CreatedDto extends createZodDto(createdSchema) {}

// ---- outages -----------------------------------------------------------------

export const outageReportInputSchema = z
  .object({ utility: z.enum(UTILITIES), location: pointInput.nullable().optional() })
  .strict();
export type OutageReportInput = z.infer<typeof outageReportInputSchema>;
export class OutageReportInputDto extends createZodDto(outageReportInputSchema) {}

export const outageReportResultSchema = z.object({
  reporters: z.number(),
  /** outage_report_min_reports: the area shows once reporters reach it. */
  threshold: z.number(),
  shown: z.boolean(),
});
export type OutageReportResult = z.infer<typeof outageReportResultSchema>;
export class OutageReportResultDto extends createZodDto(outageReportResultSchema) {}

export const outageInputSchema = z
  .object({
    utility: z.enum(UTILITIES),
    localityId: uuid.nullable().optional(),
    areaText: text(TITLE_MAX).nullable().optional(),
    startsAt: instant,
    endsAt: instant,
    reason: text(SHORT_MAX).nullable().optional(),
  })
  .strict()
  .refine((o) => new Date(o.endsAt) > new Date(o.startsAt), 'ends before it starts');
export type OutageInput = z.infer<typeof outageInputSchema>;
export class OutageInputDto extends createZodDto(outageInputSchema) {}

export const outageAdminListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      utility: z.string(),
      localityId: z.string().nullable(),
      areaText: z.string().nullable(),
      startsAt: z.string(),
      endsAt: z.string(),
      reason: z.string().nullable(),
      status: z.string(),
    }),
  ),
  localities: z.array(z.object({ id: z.string(), name: localized })),
});
export type OutageAdminList = z.infer<typeof outageAdminListSchema>;
export class OutageAdminListDto extends createZodDto(outageAdminListSchema) {}

// ---- notices -----------------------------------------------------------------

export const noticeListQuerySchema = z
  .object({ ...origin, category: z.enum(NOTICE_CATEGORIES).optional() })
  .strict()
  .refine(pairedOrigin, 'lat and lng go together');
export type NoticeListQuery = z.infer<typeof noticeListQuerySchema>;
export class NoticeListQueryDto extends createZodDto(noticeListQuerySchema) {}

/** A janaza/condolence notice's fields: the respectful wording is the apps'. */
const templateFieldsSchema = z
  .object({
    deceasedName: text(TITLE_MAX).min(1),
    age: z.number().int().min(0).max(AGE_MAX).nullable().optional(),
    relation: text(TITLE_MAX).nullable().optional(),
    janazaAt: instant.nullable().optional(),
    janazaPlace: text(TITLE_MAX).nullable().optional(),
    burialPlace: text(TITLE_MAX).nullable().optional(),
  })
  .strict();

export const noticeInputSchema = z
  .object({
    type: z.enum(NOTICE_TYPES),
    title: text(TITLE_MAX).min(1),
    body: text(TEXT_MAX).min(1),
    issuerName: text(TITLE_MAX).nullable().optional(),
    template: z.enum(NOTICE_TEMPLATES).nullable().optional(),
    templateFields: templateFieldsSchema.nullable().optional(),
    eventStartsAt: instant.nullable().optional(),
    eventEndsAt: instant.nullable().optional(),
    validFrom: instant.nullable().optional(),
    expiresAt: instant.nullable().optional(),
    /** Staff only. */
    isOfficial: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    attachmentIds: z.array(uuid).max(MEDIA_IDS_CEILING).default([]),
  })
  .strict()
  .refine((n) => (n.template ? n.templateFields != null : true), 'a template needs its fields')
  .refine(
    (n) => !n.validFrom || !n.expiresAt || new Date(n.expiresAt) > new Date(n.validFrom),
    'ends before it starts',
  );
export type NoticeInput = z.infer<typeof noticeInputSchema>;
export class NoticeInputDto extends createZodDto(noticeInputSchema) {}

export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'document']),
  mimeType: z.string(),
  /** A short-lived link (notice_attachment_url_ttl_seconds) for a document; the public variant for an image. */
  url: z.string(),
  thumbhash: z.string().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const noticeDetailSchema = z.object({
  card: infoCardSchema,
  type: z.string(),
  category: z.string(),
  body: z.string(),
  issuerName: z.string().nullable(),
  isOfficial: z.boolean(),
  isPinned: z.boolean(),
  template: z.string().nullable(),
  templateFields: z.record(z.unknown()),
  validFrom: z.string().nullable(),
  expiresAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  areaName: z.string().nullable(),
  attachments: z.array(attachmentSchema),
});
export type NoticeDetail = z.infer<typeof noticeDetailSchema>;
export class NoticeDetailDto extends createZodDto(noticeDetailSchema) {}

// ---- lost & found ----------------------------------------------------------------

export const lostFoundListQuerySchema = z
  .object({
    ...origin,
    kind: z.enum(LOST_FOUND_KINDS).optional(),
    itemType: z.enum(LOST_FOUND_ITEM_TYPES).optional(),
  })
  .strict()
  .refine(pairedOrigin, 'lat and lng go together');
export type LostFoundListQuery = z.infer<typeof lostFoundListQuerySchema>;
export class LostFoundListQueryDto extends createZodDto(lostFoundListQuerySchema) {}

export const lostFoundInputSchema = z
  .object({
    kind: z.enum(LOST_FOUND_KINDS),
    itemType: z.enum(LOST_FOUND_ITEM_TYPES),
    title: text(TITLE_MAX).min(1),
    description: text(TEXT_MAX).nullable().optional(),
    locationText: text(TITLE_MAX).nullable().optional(),
    location: pointInput.nullable().optional(),
    lastSeenAt: instant.nullable().optional(),
    /** Defaults to the reporter's own number; revealed only through the contact endpoint. */
    contactPhone: bdMobile.optional(),
    reward: money.nullable().optional(),
    photoIds: z.array(uuid).max(MEDIA_IDS_CEILING).default([]),
  })
  .strict();
export type LostFoundInput = z.infer<typeof lostFoundInputSchema>;
export class LostFoundInputDto extends createZodDto(lostFoundInputSchema) {}

export const lostFoundDetailSchema = z.object({
  card: infoCardSchema,
  kind: z.string(),
  itemType: z.string(),
  description: z.string().nullable(),
  locationText: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  reward: z.string().nullable(),
  status: z.string(),
  isMine: z.boolean(),
  photos: z.array(attachmentSchema),
  createdAt: z.string(),
});
export type LostFoundDetail = z.infer<typeof lostFoundDetailSchema>;
export class LostFoundDetailDto extends createZodDto(lostFoundDetailSchema) {}

export const lostFoundContactSchema = z.object({ channel: z.enum(CONTACT_CHANNELS) }).strict();
export class LostFoundContactDto extends createZodDto(lostFoundContactSchema) {}

// ---- moderation ------------------------------------------------------------------

export const moderationParamSchema = z
  .object({ kind: z.enum(['notice', 'lost_found']), id: uuid })
  .strict();
export class ModerationParamDto extends createZodDto(moderationParamSchema) {}

export const decisionSchema = z
  .object({
    decision: z.enum(MODERATION_DECISIONS),
    reasonCode: z.enum(MODERATION_REASONS),
    reasonText: text(SHORT_MAX).optional(),
  })
  .strict()
  .refine(
    (d) => d.decision === 'approve' || (d.reasonText ?? '').length >= REASON_MIN,
    'a reason text is needed to reject or remove',
  );
export type DecisionInput = z.infer<typeof decisionSchema>;
export class InfoDecisionDto extends createZodDto(decisionSchema) {}

export const moderationQueueSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(['notice', 'lost_found']),
      id: z.string(),
      type: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      template: z.string().nullable(),
      templateFields: z.record(z.unknown()),
      authorName: z.string().nullable(),
      createdAt: z.string(),
      photos: z.array(attachmentSchema),
      openReports: z.number(),
      /** pending_review = waiting; anything else is live and reported. */
      status: z.string(),
    }),
  ),
});
export type ModerationQueue = z.infer<typeof moderationQueueSchema>;
export class ModerationQueueDto extends createZodDto(moderationQueueSchema) {}

// ---- transport ---------------------------------------------------------------------

export const routeListQuerySchema = z
  .object({ ...origin, mode: z.enum(TRANSPORT_MODES).optional() })
  .strict()
  .refine(pairedOrigin, 'lat and lng go together');
export type RouteListQuery = z.infer<typeof routeListQuerySchema>;
export class RouteListQueryDto extends createZodDto(routeListQuerySchema) {}

export const routeInputSchema = z
  .object({
    mode: z.enum(TRANSPORT_MODES),
    nameBn: text(TITLE_MAX).min(1),
    nameEn: text(TITLE_MAX).nullable().optional(),
    operatorName: text(TITLE_MAX).nullable().optional(),
    originName: text(TITLE_MAX).min(1),
    destinationName: text(TITLE_MAX).min(1),
    originLocation: pointInput.nullable().optional(),
    destinationLocation: pointInput.nullable().optional(),
    typicalDurationMinutes: z.number().int().positive().nullable().optional(),
    fareMin: money.nullable().optional(),
    fareMax: money.nullable().optional(),
    contactPhones: z
      .array(z.string().regex(/^\+?[0-9]{3,15}$/))
      .max(LIST_MAX)
      .default([]),
    notes: text(SHORT_MAX).nullable().optional(),
    stops: z
      .array(
        z
          .object({
            nameBn: text(TITLE_MAX).min(1),
            location: pointInput.nullable().optional(),
            minutesFromOrigin: z.number().int().min(0).nullable().optional(),
            fareFromOrigin: money.nullable().optional(),
          })
          .strict(),
      )
      .max(LIST_MAX)
      .default([]),
    schedules: z
      .array(
        z
          .object({
            direction: z.enum(['outbound', 'return']).default('outbound'),
            departureTime: clock,
            days: z
              .array(z.number().int().min(ISO_MONDAY).max(ISO_SUNDAY))
              .min(1)
              .default(EVERY_DAY),
            validFrom: isoDate.nullable().optional(),
            validTo: isoDate.nullable().optional(),
            serviceClass: text(TITLE_MAX).nullable().optional(),
            fare: money.nullable().optional(),
          })
          .strict(),
      )
      .max(SCHEDULE_MAX)
      .default([]),
  })
  .strict()
  .refine(
    (r) => !r.fareMin || !r.fareMax || Number(r.fareMax) >= Number(r.fareMin),
    'max fare below min fare',
  );
export type RouteInput = z.infer<typeof routeInputSchema>;
export class RouteInputDto extends createZodDto(routeInputSchema) {}

export const routeDetailSchema = z.object({
  card: infoCardSchema,
  mode: z.string(),
  operatorName: z.string().nullable(),
  originName: z.string(),
  destinationName: z.string(),
  originLocation: point.nullable(),
  destinationLocation: point.nullable(),
  typicalDurationMinutes: z.number().nullable(),
  fareMin: z.string().nullable(),
  fareMax: z.string().nullable(),
  fareUpdatedOn: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  contactPhones: z.array(z.string()),
  notes: z.string().nullable(),
  stops: z.array(
    z.object({
      seq: z.number(),
      name: localized,
      location: point.nullable(),
      minutesFromOrigin: z.number().nullable(),
      fareFromOrigin: z.string().nullable(),
    }),
  ),
  schedules: z.array(
    z.object({
      id: z.string(),
      direction: z.string(),
      departureTime: z.string(),
      days: z.array(z.number()),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
      serviceClass: z.string().nullable(),
      fare: z.string().nullable(),
    }),
  ),
  /** From now, in the area's own time (transport_next_departures). */
  nextDepartures: z.array(
    z.object({
      departsAt: z.string(),
      direction: z.string(),
      serviceClass: z.string().nullable(),
      fare: z.string().nullable(),
    }),
  ),
});
export type RouteDetail = z.infer<typeof routeDetailSchema>;
export class RouteDetailDto extends createZodDto(routeDetailSchema) {}

/** The area team's routes, in full (to edit). */
export const routeAdminListSchema = z.object({ items: z.array(routeDetailSchema) });
export type RouteAdminList = z.infer<typeof routeAdminListSchema>;
export class RouteAdminListDto extends createZodDto(routeAdminListSchema) {}

// ---- government service guide -----------------------------------------------------

export const govListQuerySchema = z
  .object({ category: z.enum(GOV_CATEGORIES).optional() })
  .strict();
export class GovListQueryDto extends createZodDto(govListQuerySchema) {}

export const govServiceInputSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    category: z.enum(GOV_CATEGORIES),
    nameBn: text(TITLE_MAX).min(1),
    nameEn: text(TITLE_MAX).nullable().optional(),
    summaryBn: text(SHORT_MAX).nullable().optional(),
    officeName: text(TITLE_MAX).min(1),
    officePlaceId: uuid.nullable().optional(),
    address: text(SHORT_MAX).nullable().optional(),
    location: pointInput.nullable().optional(),
    hours: text(SHORT_MAX).nullable().optional(),
    documents: z.array(text(SHORT_MAX).min(1)).max(LIST_MAX).default([]),
    fees: z
      .array(z.object({ label: text(TITLE_MAX).min(1), amount: money }).strict())
      .max(LIST_MAX)
      .default([]),
    steps: z.array(text(SHORT_MAX).min(1)).max(LIST_MAX).default([]),
    links: z
      .array(
        z
          .object({
            label: text(TITLE_MAX).min(1),
            url: z
              .string()
              .url()
              .regex(/^https:\/\//, 'https only'),
          })
          .strict(),
      )
      .max(LIST_MAX)
      .default([]),
    changeNote: text(SHORT_MAX).nullable().optional(),
  })
  .strict();
export type GovServiceInput = z.infer<typeof govServiceInputSchema>;
export class GovServiceInputDto extends createZodDto(govServiceInputSchema) {}

const govVersionSchema = z.object({
  versionNo: z.number(),
  name: localized,
  summary: z.string().nullable(),
  officeName: z.string(),
  officePlaceId: z.string().nullable(),
  address: z.string().nullable(),
  location: point.nullable(),
  hours: z.string().nullable(),
  documents: z.array(z.string()),
  fees: z.array(z.object({ label: z.string(), amount: z.string() })),
  steps: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
});
export type GovVersion = z.infer<typeof govVersionSchema>;

export const govServiceDetailSchema = z.object({
  card: infoCardSchema,
  id: z.string(),
  slug: z.string(),
  category: z.string(),
  lastVerifiedOn: z.string(),
  current: govVersionSchema,
  versions: z.array(
    z.object({ versionNo: z.number(), createdAt: z.string(), changeNote: z.string().nullable() }),
  ),
});
export type GovServiceDetail = z.infer<typeof govServiceDetailSchema>;
export class GovServiceDetailDto extends createZodDto(govServiceDetailSchema) {}

export const govVersionParamSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    no: z.coerce.number().int().positive(),
  })
  .strict();
export class GovVersionParamDto extends createZodDto(govVersionParamSchema) {}
export const govVersionResultSchema = govVersionSchema;
export class GovVersionDto extends createZodDto(govVersionSchema) {}

export const publishedSchema = z.object({ id: z.string(), versionNo: z.number() });
export type Published = z.infer<typeof publishedSchema>;
export class PublishedDto extends createZodDto(publishedSchema) {}

// ---- directories --------------------------------------------------------------------

export const directoryQuerySchema = z
  .object({
    ...origin,
    kind: z.enum(DIRECTORY_KINDS),
    /** One or more values of the kind's type field (e.g. diagnostic,clinic). */
    sub: z
      .string()
      .regex(/^[a-z_]+(,[a-z_]+)*$/)
      .optional(),
    open24: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    after: z
      .string()
      .regex(/^[0-9.]+_[0-9a-f-]{36}$/)
      .optional(),
  })
  .strict()
  .refine(pairedOrigin, 'lat and lng go together');
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
export class DirectoryQueryDto extends createZodDto(directoryQuerySchema) {}

// ---- prayer -------------------------------------------------------------------------

export const PRAYER_METHODS = ['karachi', 'mwl', 'isna', 'egypt', 'umm_al_qura'] as const;
export const prayerSettingsSchema = z.object({
  method: z.enum(PRAYER_METHODS),
  asrSchool: z.enum(['hanafi', 'standard']),
  hijriAdjustDays: z.number(),
  sehriCautionMinutes: z.number(),
  iftarCautionMinutes: z.number(),
  /** The area's centre: where the apps calculate when the device has no fix. */
  center: point.nullable(),
  timezone: z.string(),
});
export type PrayerSettings = z.infer<typeof prayerSettingsSchema>;
export class PrayerSettingsDto extends createZodDto(prayerSettingsSchema) {}

/** Which local information services this area offers (rural: agriculture). */
export const servicesSchema = z.object({ agri: z.boolean() });
export type InfoServices = z.infer<typeof servicesSchema>;
export class InfoServicesDto extends createZodDto(servicesSchema) {}

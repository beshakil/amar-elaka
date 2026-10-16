import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { CONTACT_CHANNELS } from '../../engagement/dto/engagement.dto';

/**
 * Local information services (ADR 064): emergency contacts, blood donors and
 * urgent requests, daily bazar prices. Codes are lookup values (0011, 0060);
 * the clients name them in their own strings.
 */

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: generic input-length caps on free text, not business thresholds
const NAME_MAX = 200;
// settings-exempt: see above
const NOTE_MAX = 500;
// settings-exempt: see above
const URL_MAX = 500;
// settings-exempt: blood_requests_units_needed_ck (1..10) mirrored for a clean 400
const UNITS_MAX = 10;
// settings-exempt: emergency_contacts.phones is a short list; a ceiling for input only
const PHONES_MAX = 5;
// settings-exempt: a whole board in one save; the real list is the area's catalogue
const ENTRY_ITEMS_MAX = 200;
// settings-exempt: money column numeric(12,2)
const PRICE_MAX = 9_999_999_999.99;
// settings-exempt: input sanity floors on free text, not business thresholds
const HOSPITAL_NAME_MIN = 2;
// settings-exempt: see above
const REASON_TEXT_MIN = 3;

export const BLOOD_GROUPS = [
  'a_pos',
  'a_neg',
  'b_pos',
  'b_neg',
  'ab_pos',
  'ab_neg',
  'o_pos',
  'o_neg',
] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
/** donor_contact_windows (0060). */
export const CONTACT_WINDOWS = ['any', 'morning', 'afternoon', 'evening', 'daytime'] as const;
/** donor_contact_preferences (0011): share the number on request, or in-app asks only. */
export const CONTACT_PREFERENCES = ['in_app_only', 'reveal_on_request'] as const;
export const URGENCY_LEVELS = ['critical', 'urgent', 'planned'] as const;
export const REQUEST_STATUSES = ['open', 'fulfilled', 'cancelled', 'expired', 'removed'] as const;
/** moderation_reasons a blood request may be removed for (remove_blood_request, 0060). */
export const BLOOD_REQUEST_REMOVAL_REASONS = ['fake_blood_request', 'blood_request_abuse'] as const;
/** emergency_service_types (0011, 0060). */
export const EMERGENCY_SERVICE_TYPES = [
  'national_emergency',
  'police',
  'fire_service',
  'hospital',
  'ambulance',
  'pharmacy_24h',
  'electricity',
  'gas',
  'union_parishad',
  'upazila_office',
  'women_child_helpline',
  'health_helpline',
  'child_helpline',
  'legal_aid',
  'disaster_warning',
  'information',
  'anti_corruption',
] as const;
/** measurement_units (0011). */
export const MEASUREMENT_UNITS = ['kg', 'litre', 'piece', 'dozen', 'hali', 'hundred'] as const;

const uuid = z.string().uuid();
const coordinate = (max: number) => z.coerce.number().min(-max).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-15');
const bdMobile = z.string().regex(/^\+8801[3-9]\d{8}$/, 'a BD mobile number like +8801712345678');
/** Money as a string with up to two decimals (§0.2), never a float. */
const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'an amount like 45 or 45.50')
  .refine((v) => Number(v) > 0 && Number(v) <= PRICE_MAX, 'a positive amount');
const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });
const point = z.object({ lat: z.number(), lng: z.number() });

// ---- shared query/params --------------------------------------------------

export const idParamSchema = z.object({ id: uuid }).strict();
export class InfoIdParamDto extends createZodDto(idParamSchema) {}

export const originQuerySchema = z
  .object({ lat: coordinate(MAX_LAT).optional(), lng: coordinate(MAX_LNG).optional() })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), 'lat and lng go together');
export type OriginQuery = z.infer<typeof originQuerySchema>;
export class OriginQueryDto extends createZodDto(originQuerySchema) {}

// ---- emergency -------------------------------------------------------------

export const emergencyContactSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  serviceType: z.string(),
  name: localized,
  phones: z.array(z.string()),
  address: z.string().nullable(),
  location: point.nullable(),
  is24h: z.boolean(),
  availabilityNote: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  /** From the viewer (or the area's centre); null for a contact without a point. */
  distanceMeters: z.number().nullable(),
});
export type EmergencyContact = z.infer<typeof emergencyContactSchema>;

export const emergencyPageSchema = z.object({
  /** A hash of the content: the apps keep their offline copy until it changes. */
  version: z.string(),
  generatedAt: z.string(),
  /** emergency_refresh_hours, in seconds: when the apps refresh in the background. */
  refreshAfterSeconds: z.number(),
  radiusKm: z.number(),
  national: z.array(
    z.object({
      id: z.string(),
      serviceType: z.string(),
      name: localized,
      description: localized,
      dial: z.string(),
    }),
  ),
  /** Local contacts grouped by service type, in the lookup's order; nearest first inside a group. */
  groups: z.array(z.object({ serviceType: z.string(), contacts: z.array(emergencyContactSchema) })),
});
export type EmergencyPage = z.infer<typeof emergencyPageSchema>;
export class EmergencyPageDto extends createZodDto(emergencyPageSchema) {}

/** Staff and field agents keep the area's contacts current. */
export const emergencyContactInputSchema = z
  .object({
    serviceType: z.enum(EMERGENCY_SERVICE_TYPES),
    nameBn: z.string().trim().min(1).max(NAME_MAX),
    nameEn: z.string().trim().max(NAME_MAX).nullable().optional(),
    phones: z
      .array(z.string().regex(/^\+?[0-9]{3,15}$/, 'a phone number or short code'))
      .min(1)
      .max(PHONES_MAX),
    address: z.string().trim().max(NOTE_MAX).nullable().optional(),
    location: z
      .object({ lat: coordinate(MAX_LAT), lng: coordinate(MAX_LNG) })
      .nullable()
      .optional(),
    is24h: z.boolean().default(false),
    availabilityNote: z.string().trim().max(NOTE_MAX).nullable().optional(),
    sortOrder: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();
export type EmergencyContactInput = z.infer<typeof emergencyContactInputSchema>;
export class EmergencyContactInputDto extends createZodDto(emergencyContactInputSchema) {}

export const emergencyAdminListSchema = z.object({
  items: z.array(emergencyContactSchema.extend({ isActive: z.boolean(), sortOrder: z.number() })),
});
export type EmergencyAdminList = z.infer<typeof emergencyAdminListSchema>;
export class EmergencyAdminListDto extends createZodDto(emergencyAdminListSchema) {}

// ---- blood: donors -----------------------------------------------------------

export const donorSearchQuerySchema = z
  .object({
    group: z.enum(BLOOD_GROUPS),
    /** Also donors whose group the recipient can take (blood_group_compatibility). */
    compatible: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    lat: coordinate(MAX_LAT).optional(),
    lng: coordinate(MAX_LNG).optional(),
    radius_km: z.coerce.number().positive().optional(),
    /** The previous page's `next`. */
    after: z
      .string()
      .regex(/^[0-9.]+_[0-9a-f-]{36}$/)
      .optional(),
  })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), 'lat and lng go together');
export type DonorSearchQuery = z.infer<typeof donorSearchQuerySchema>;
export class DonorSearchQueryDto extends createZodDto(donorSearchQuerySchema) {}

export const donorCardSchema = z.object({
  id: z.string(),
  bloodGroup: z.string(),
  displayName: z.string().nullable(),
  area: localized.nullable(),
  /** Rounded to the location grid: never a home's exact distance. */
  distanceMeters: z.number(),
  contactWindow: z.string(),
  /** reveal_on_request: a call is possible; in_app_only: the donor is asked to get back. */
  contactPreference: z.string(),
  lastDonatedOn: z.string().nullable(),
});
export const donorPageSchema = z.object({
  items: z.array(donorCardSchema),
  radiusKm: z.number(),
  next: z.string().nullable(),
});
export type DonorPage = z.infer<typeof donorPageSchema>;
export class DonorPageDto extends createZodDto(donorPageSchema) {}

export const registerDonorSchema = z
  .object({
    bloodGroup: z.enum(BLOOD_GROUPS),
    localityId: uuid.nullable().optional(),
    /** Where the donor usually is; stored snapped to a grid (blood_donor_location_grid_m). */
    location: z.object({ lat: coordinate(MAX_LAT), lng: coordinate(MAX_LNG) }),
    lastDonatedOn: isoDate.nullable().optional(),
    contactWindow: z.enum(CONTACT_WINDOWS).default('any'),
    contactPreference: z.enum(CONTACT_PREFERENCES).default('in_app_only'),
    alertsEnabled: z.boolean().default(true),
    /** Self-declared age and health eligibility (schema.md §10.4). */
    eligibilityConfirmed: z.literal(true),
    /** The blood_donor_listing consent (user_consents). */
    consent: z.literal(true),
  })
  .strict();
export type RegisterDonorInput = z.infer<typeof registerDonorSchema>;
export class RegisterDonorDto extends createZodDto(registerDonorSchema) {}

export const availabilitySchema = z.object({ available: z.boolean() }).strict();
export class AvailabilityDto extends createZodDto(availabilitySchema) {}

export const donationSchema = z.object({ donatedOn: isoDate }).strict();
export class DonationDto extends createZodDto(donationSchema) {}

export const myDonorSchema = z.object({
  donor: z
    .object({
      id: z.string(),
      bloodGroup: z.string(),
      localityId: z.string().nullable(),
      location: point.nullable(),
      lastDonatedOn: z.string().nullable(),
      /** When the donation gap (blood_donation_interval_days) ends; null = no gap. */
      eligibleFrom: z.string().nullable(),
      isAvailable: z.boolean(),
      /** Listed right now: available and past the gap. */
      isListed: z.boolean(),
      contactWindow: z.string(),
      contactPreference: z.string(),
      alertsEnabled: z.boolean(),
      contactsToday: z.number(),
      dailyContactCap: z.number(),
    })
    .nullable(),
});
export type MyDonor = z.infer<typeof myDonorSchema>;
export class MyDonorDto extends createZodDto(myDonorSchema) {}

export const donorContactsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      requesterName: z.string().nullable(),
      /** donor_request: asked in-app; call_click / sms_click / whatsapp_click: took the number. */
      channel: z.string(),
      request: z
        .object({
          id: z.string(),
          bloodGroup: z.string(),
          hospitalName: z.string(),
          neededBy: z.string(),
          status: z.string(),
        })
        .nullable(),
    }),
  ),
});
export type DonorContacts = z.infer<typeof donorContactsSchema>;
export class DonorContactsDto extends createZodDto(donorContactsSchema) {}

export const donorContactInputSchema = z
  .object({
    channel: z.enum(CONTACT_CHANNELS),
    /** The caller's own open request, shown to the donor. */
    requestId: uuid.optional(),
  })
  .strict();
export type DonorContactInput = z.infer<typeof donorContactInputSchema>;
export class DonorContactInputDto extends createZodDto(donorContactInputSchema) {}

export const donorContactResultSchema = z.object({
  /** phone: the number is in `reveal`; asked: the donor was notified and will get back. */
  mode: z.enum(['phone', 'asked']),
  reveal: z
    .object({
      channel: z.string(),
      name: z.string().nullable(),
      phone: z.string(),
      href: z.string(),
      message: z.string().nullable(),
    })
    .nullable(),
});
export type DonorContactResult = z.infer<typeof donorContactResultSchema>;
export class DonorContactResultDto extends createZodDto(donorContactResultSchema) {}

// ---- blood: requests ---------------------------------------------------------

export const createBloodRequestSchema = z
  .object({
    bloodGroup: z.enum(BLOOD_GROUPS),
    units: z.number().int().min(1).max(UNITS_MAX).default(1),
    hospitalName: z.string().trim().min(HOSPITAL_NAME_MIN).max(NAME_MAX),
    hospitalPlaceId: uuid.nullable().optional(),
    /** The hospital's point: donors near it are alerted. */
    location: z.object({ lat: coordinate(MAX_LAT), lng: coordinate(MAX_LNG) }),
    neededBy: z.string().datetime({ offset: true }),
    urgency: z.enum(URGENCY_LEVELS),
    patientNote: z.string().trim().max(NOTE_MAX).nullable().optional(),
    /** Defaults to the requester's own number. */
    contactPhone: bdMobile.optional(),
  })
  .strict();
export type CreateBloodRequestInput = z.infer<typeof createBloodRequestSchema>;
export class CreateBloodRequestDto extends createZodDto(createBloodRequestSchema) {}

export const bloodRequestCardSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  bloodGroup: z.string(),
  units: z.number(),
  hospitalName: z.string(),
  neededBy: z.string(),
  urgency: z.string(),
  status: z.string(),
  createdAt: z.string(),
  distanceMeters: z.number().nullable(),
  isMine: z.boolean(),
});
export type BloodRequestCard = z.infer<typeof bloodRequestCardSchema>;

export const bloodRequestListQuerySchema = z
  .object({
    group: z.enum(BLOOD_GROUPS).optional(),
    lat: coordinate(MAX_LAT).optional(),
    lng: coordinate(MAX_LNG).optional(),
    radius_km: z.coerce.number().positive().optional(),
  })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), 'lat and lng go together');
export type BloodRequestListQuery = z.infer<typeof bloodRequestListQuerySchema>;
export class BloodRequestListQueryDto extends createZodDto(bloodRequestListQuerySchema) {}

export const bloodRequestListSchema = z.object({
  items: z.array(bloodRequestCardSchema),
  radiusKm: z.number().nullable(),
});
export type BloodRequestList = z.infer<typeof bloodRequestListSchema>;
export class BloodRequestListDto extends createZodDto(bloodRequestListSchema) {}

export const bloodRequestDetailSchema = bloodRequestCardSchema.extend({
  patientNote: z.string().nullable(),
  location: point.nullable(),
  requesterName: z.string().nullable(),
  /** How many donors the request reached (its own requester sees it). */
  alertedDonors: z.number().nullable(),
});
export type BloodRequestDetail = z.infer<typeof bloodRequestDetailSchema>;
export class BloodRequestDetailDto extends createZodDto(bloodRequestDetailSchema) {}

export const createdBloodRequestSchema = z.object({
  id: z.string(),
  /** Donors pushed right away (the alert job retries a failed match). */
  alertedDonors: z.number(),
});
export type CreatedBloodRequest = z.infer<typeof createdBloodRequestSchema>;
export class CreatedBloodRequestDto extends createZodDto(createdBloodRequestSchema) {}

export const closeBloodRequestSchema = z
  .object({ outcome: z.enum(['fulfilled', 'cancelled']) })
  .strict();
export class CloseBloodRequestDto extends createZodDto(closeBloodRequestSchema) {}

export const requestContactInputSchema = z.object({ channel: z.enum(CONTACT_CHANNELS) }).strict();
export class RequestContactInputDto extends createZodDto(requestContactInputSchema) {}

export const removeBloodRequestSchema = z
  .object({
    reasonCode: z.enum(BLOOD_REQUEST_REMOVAL_REASONS),
    reasonText: z.string().trim().min(REASON_TEXT_MIN).max(NOTE_MAX),
  })
  .strict();
export class RemoveBloodRequestDto extends createZodDto(removeBloodRequestSchema) {}

// ---- bazar -------------------------------------------------------------------

const priceRange = z.object({ min: z.string(), max: z.string() });

export const bazarBoardItemSchema = z.object({
  commodityId: z.string(),
  code: z.string(),
  name: localized,
  group: z.string(),
  unit: z.string(),
  today: priceRange.nullable(),
  yesterday: priceRange.nullable(),
  /** Today's mid-price against yesterday's; null without both. */
  direction: z.enum(['up', 'down', 'same']).nullable(),
  /** One entry per day, oldest first (bazar_trend_days); null where nothing was entered. */
  trend: z.array(z.object({ date: z.string(), min: z.string(), max: z.string() }).nullable()),
});
export type BazarBoardItem = z.infer<typeof bazarBoardItemSchema>;

export const bazarSponsorSchema = z.object({
  name: localized,
  tagline: z.string().nullable(),
  linkUrl: z.string().nullable(),
});
export type BazarSponsor = z.infer<typeof bazarSponsorSchema>;

export const bazarBoardSchema = z.object({
  /** Today in the area's own zone. */
  date: z.string(),
  /** The last day with any price, or null. */
  lastUpdated: z.string().nullable(),
  /** Nothing entered today: the apps show the "not updated today" banner. */
  isStale: z.boolean(),
  trendDays: z.number(),
  sponsor: bazarSponsorSchema.nullable(),
  items: z.array(bazarBoardItemSchema),
});
export type BazarBoard = z.infer<typeof bazarBoardSchema>;
export class BazarBoardDto extends createZodDto(bazarBoardSchema) {}

/** bazar: the daily market; agri: agricultural inputs (rural areas, ADR 065). */
export const BAZAR_BOARDS = ['bazar', 'agri'] as const;
export const bazarBoardQuerySchema = z
  .object({ board: z.enum(BAZAR_BOARDS).default('bazar') })
  .strict();
export class BazarBoardQueryDto extends createZodDto(bazarBoardQuerySchema) {}

export const bazarEntryQuerySchema = z
  .object({ date: isoDate.optional(), board: z.enum(BAZAR_BOARDS).default('bazar') })
  .strict();
export class BazarEntryQueryDto extends createZodDto(bazarEntryQuerySchema) {}

export const bazarEntrySheetSchema = z.object({
  date: z.string(),
  /** The earliest date that may still be entered (bazar_entry_backdate_days). */
  earliestDate: z.string(),
  items: z.array(
    z.object({
      commodityId: z.string(),
      code: z.string(),
      name: localized,
      group: z.string(),
      unit: z.string(),
      /** What is saved for `date`, if anything. */
      entered: priceRange.nullable(),
      /** The previous day's figure: the prefill. */
      previous: priceRange.nullable(),
    }),
  ),
});
export type BazarEntrySheet = z.infer<typeof bazarEntrySheetSchema>;
export class BazarEntrySheetDto extends createZodDto(bazarEntrySheetSchema) {}

export const bazarEntryInputSchema = z
  .object({
    date: isoDate,
    items: z
      .array(
        z
          .object({
            commodityId: uuid,
            unitCode: z.enum(MEASUREMENT_UNITS),
            minPrice: money,
            maxPrice: money,
          })
          .strict()
          .refine((i) => Number(i.maxPrice) >= Number(i.minPrice), 'max below min'),
      )
      .min(1)
      .max(ENTRY_ITEMS_MAX),
  })
  .strict();
export type BazarEntryInput = z.infer<typeof bazarEntryInputSchema>;
export class BazarEntryInputDto extends createZodDto(bazarEntryInputSchema) {}

export const bazarEntryResultSchema = z.object({ saved: z.number() });
export class BazarEntryResultDto extends createZodDto(bazarEntryResultSchema) {}

export const bazarCatalogueSchema = z.object({
  /** True once the area chose its own items; false = every active commodity. */
  customised: z.boolean(),
  commodities: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: localized,
      group: z.string(),
      defaultUnit: z.string(),
      /** On the area's board, in this unit and position (null = not on it). */
      selected: z.object({ unit: z.string(), sortOrder: z.number() }).nullable(),
    }),
  ),
});
export type BazarCatalogue = z.infer<typeof bazarCatalogueSchema>;
export class BazarCatalogueDto extends createZodDto(bazarCatalogueSchema) {}

export const bazarCatalogueInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            commodityId: uuid,
            unitCode: z.enum(MEASUREMENT_UNITS),
            sortOrder: z.number().int().min(0),
          })
          .strict(),
      )
      .max(ENTRY_ITEMS_MAX),
  })
  .strict();
export type BazarCatalogueInput = z.infer<typeof bazarCatalogueInputSchema>;
export class BazarCatalogueInputDto extends createZodDto(bazarCatalogueInputSchema) {}

export const bazarSponsorInputSchema = z
  .object({
    nameBn: z.string().trim().min(1).max(NAME_MAX),
    nameEn: z.string().trim().max(NAME_MAX).nullable().optional(),
    taglineBn: z.string().trim().max(NAME_MAX).nullable().optional(),
    linkUrl: z
      .string()
      .url()
      .max(URL_MAX)
      .regex(/^https:\/\//, 'https only')
      .nullable()
      .optional(),
    startsOn: isoDate,
    endsOn: isoDate.nullable().optional(),
  })
  .strict()
  .refine((s) => !s.endsOn || s.endsOn >= s.startsOn, 'ends before it starts');
export type BazarSponsorInput = z.infer<typeof bazarSponsorInputSchema>;
export class BazarSponsorInputDto extends createZodDto(bazarSponsorInputSchema) {}

export const bazarSponsorAdminSchema = z.object({
  sponsor: z
    .object({
      id: z.string(),
      nameBn: z.string(),
      nameEn: z.string().nullable(),
      taglineBn: z.string().nullable(),
      linkUrl: z.string().nullable(),
      startsOn: z.string(),
      endsOn: z.string().nullable(),
    })
    .nullable(),
});
export type BazarSponsorAdmin = z.infer<typeof bazarSponsorAdminSchema>;
export class BazarSponsorAdminDto extends createZodDto(bazarSponsorAdminSchema) {}

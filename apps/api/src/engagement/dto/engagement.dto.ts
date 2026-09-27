import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { postCardSchema } from '../../feed/dto/feed.dto';
import { POST_STATUSES } from '../../posts/post-state-machine';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;

// ---- requests --------------------------------------------------------------

export const postDetailQuerySchema = z
  .object({
    /** The viewer's position: gives `distanceMeters`. */
    lat: z.coerce.number().min(-MAX_LAT).max(MAX_LAT).optional(),
    lng: z.coerce.number().min(-MAX_LNG).max(MAX_LNG).optional(),
  })
  .strict()
  .refine(
    (q) => (q.lat === undefined) === (q.lng === undefined),
    'Send both lat and lng, or neither.',
  );
export type PostDetailQuery = z.infer<typeof postDetailQuerySchema>;
export class PostDetailQueryDto extends createZodDto(postDetailQuerySchema) {}

export const CONTACT_CHANNELS = ['call', 'whatsapp', 'sms'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Where the tap happened (lead_sources, 0009) — the ones a post can be contacted from. */
export const CONTACT_SOURCES = [
  'post_detail',
  'search_result',
  'store_page',
  'boosted_slot',
] as const;

export const contactSchema = z
  .object({
    channel: z.enum(CONTACT_CHANNELS),
    source: z.enum(CONTACT_SOURCES).default('post_detail'),
  })
  .strict();
export type ContactInput = z.infer<typeof contactSchema>;
export class ContactDto extends createZodDto(contactSchema) {}

/** report_reasons (0010). */
export const REPORT_REASONS = [
  'scam',
  'fake_listing',
  'prohibited_item',
  'harassment',
  'spam',
  'wrong_information',
  'duplicate',
  'other',
] as const;

// report_details_max_length is checked in the service (CLAUDE.md rule 9).
export const reportSchema = z
  .object({
    reasonCode: z.enum(REPORT_REASONS),
    text: z.string().trim().optional(),
  })
  .strict();
export type ReportInput = z.infer<typeof reportSchema>;
export class ReportDto extends createZodDto(reportSchema) {}

export const shortCodeParamSchema = z.object({ code: z.string().regex(/^[a-z0-9]{4,32}$/) });
export class ShortCodeParamDto extends createZodDto(shortCodeParamSchema) {}

// ---- responses -------------------------------------------------------------

const localized = z.object({ bn: z.string().nullable(), en: z.string().nullable() });

const variantSchema = z.object({ url: z.string(), width: z.number(), height: z.number() });

export const SELLER_BADGES = ['trusted', 'phone_verified', 'verified_store'] as const;

export const postDetailSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(POST_STATUSES),
  isSold: z.boolean(),
  title: z.string(),
  description: z.string().nullable(),
  price: z.string().nullable(),
  priceType: z.string().nullable(),
  currency: z.string(),
  category: z.object({ id: z.string(), slug: z.string(), name: localized }),
  /** The schema version the post was written against: labels come from it. */
  fieldSchemaVersion: z.number().nullable(),
  fields: z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      label: localized,
      value: z.unknown(),
      optionLabels: z.array(localized).optional(),
    }),
  ),
  /** Every photo, with every variant (thumb, card, full), in display order. */
  media: z.array(
    z.object({
      id: z.string(),
      thumbhash: z.string().nullable(),
      variants: z
        .object({ thumb: variantSchema, card: variantSchema, full: variantSchema })
        .nullable(),
    }),
  ),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  area: localized.nullable(),
  /** From the viewer's `lat`/`lng`; null without them or without a post location. */
  distanceMeters: z.number().nullable(),
  seller: z.object({
    name: z.string().nullable(),
    memberSince: z.string().nullable(),
    badges: z.array(z.enum(SELLER_BADGES)),
    store: z
      .object({ id: z.string(), slug: z.string(), name: localized, verified: z.boolean() })
      .nullable(),
    /** Null until there's chat history to measure (seller_profiles). */
    responseHint: z
      .object({ ratePercent: z.number().nullable(), medianMinutes: z.number().nullable() })
      .nullable(),
  }),
  /**
   * How a buyer may reach the seller — never the number itself. Reveal it
   * with POST /posts/:id/contact, which records the lead.
   */
  contact: z.object({
    name: z.string().nullable(),
    channels: z.array(z.enum(CONTACT_CHANNELS)),
    allowChat: z.boolean(),
    /** The post's tenant requires sign-in before a reveal (require_login_for_contact). */
    loginRequired: z.boolean(),
  }),
  share: z.object({ code: z.string(), url: z.string() }).nullable(),
  similar: z.array(postCardSchema),
  /** The seller-facing counters: owner and staff only. */
  stats: z
    .object({
      views: z.number(),
      contacts: z.object({
        call: z.number(),
        whatsapp: z.number(),
        sms: z.number(),
        total: z.number(),
      }),
      saves: z.number(),
    })
    .optional(),
  isMine: z.boolean(),
  /** The caller saved this post (false for a guest). */
  isSaved: z.boolean(),
  publishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  soldAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PostDetail = z.infer<typeof postDetailSchema>;
export class PostDetailDto extends createZodDto(postDetailSchema) {}

export const contactRevealSchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  name: z.string().nullable(),
  /** E.164, e.g. +8801712345678. */
  phone: z.string(),
  /** What to open: tel:, sms: (with the message) or a wa.me link with the message. */
  href: z.string(),
  /** The prefilled message for SMS and WhatsApp; null for a call. */
  message: z.string().nullable(),
});
export type ContactReveal = z.infer<typeof contactRevealSchema>;
export class ContactRevealDto extends createZodDto(contactRevealSchema) {}

export const reportResultSchema = z.object({
  reportId: z.string(),
  /** False when the caller had already reported this post (the open report is returned). */
  created: z.boolean(),
});
export type ReportResult = z.infer<typeof reportResultSchema>;
export class ReportResultDto extends createZodDto(reportResultSchema) {}

export const shortLinkSchema = z.object({
  code: z.string(),
  postId: z.string(),
  tenantId: z.string(),
  tenantSlug: z.string(),
  url: z.string(),
});
export type ShortLink = z.infer<typeof shortLinkSchema>;
export class ShortLinkDto extends createZodDto(shortLinkSchema) {}

import { z } from 'zod';
import { MONEY_PATTERN } from '../../categories/field-schema/money';
import { createZodDto } from '../../common/pipes/zod-dto';
import { POST_STATUSES } from '../post-state-machine';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: an Idempotency-Key is an opaque client token; this only bounds abuse input.
const IDEMPOTENCY_KEY_MAX_CHARS = 200;

// Lengths are checked against post_title_max_length / post_description_max_length
// in the service (CLAUDE.md rule 9); here only "present and not blank".
const title = z.string().trim().min(1);
const description = z.string().trim();

const location = z.object({
  lat: z.number().min(-MAX_LAT).max(MAX_LAT),
  lng: z.number().min(-MAX_LNG).max(MAX_LNG),
});

export const createPostSchema = z
  .object({
    categoryId: z.string().uuid(),
    title,
    description: description.optional(),
    /** The category's custom fields; validated against its current schema version. */
    fields: z.record(z.unknown()).default({}),
    location,
    /** Ready photos from POST /media/presign + confirm, in display order. */
    mediaIds: z.array(z.string().uuid()).default([]),
    showPhone: z.boolean().optional(),
    allowChat: z.boolean().optional(),
    /** true = submit for review right away; false = keep as a draft. */
    submit: z.boolean().default(false),
  })
  .strict();
export type CreatePostInput = z.infer<typeof createPostSchema>;
export class CreatePostDto extends createZodDto(createPostSchema) {}

export const updatePostSchema = z
  .object({
    categoryId: z.string().uuid(),
    title,
    description: description.nullable(),
    fields: z.record(z.unknown()),
    location,
    mediaIds: z.array(z.string().uuid()),
    showPhone: z.boolean(),
    allowChat: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.');
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export class UpdatePostDto extends createZodDto(updatePostSchema) {}

export const markSoldSchema = z
  .object({ soldPrice: z.string().regex(MONEY_PATTERN, 'a money amount like 1500.00').optional() })
  .strict();
export type MarkSoldInput = z.infer<typeof markSoldSchema>;
export class MarkSoldDto extends createZodDto(markSoldSchema) {}

export const postIdParamSchema = z.object({ id: z.string().uuid() });
export class PostIdParamDto extends createZodDto(postIdParamSchema) {}

export const myPostsQuerySchema = z
  .object({
    /** Comma-separated statuses, e.g. `live,pending`. */
    status: z
      .string()
      .transform((raw) =>
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      )
      .pipe(z.array(z.enum(POST_STATUSES)).min(1))
      .optional(),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type MyPostsQuery = z.infer<typeof myPostsQuerySchema>;
export class MyPostsQueryDto extends createZodDto(myPostsQuerySchema) {}

export const ownershipQuerySchema = z
  .object({
    lat: z.coerce.number().min(-MAX_LAT).max(MAX_LAT),
    lng: z.coerce.number().min(-MAX_LNG).max(MAX_LNG),
  })
  .strict();
export class OwnershipQueryDto extends createZodDto(ownershipQuerySchema) {}

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_CHARS)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII only');

// ---- responses -------------------------------------------------------------

const mediaSchema = z.object({
  id: z.string(),
  thumbhash: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  cardUrl: z.string().nullable(),
  fullUrl: z.string().nullable(),
});

export const postSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(POST_STATUSES),
  categoryId: z.string(),
  fieldSchemaId: z.string(),
  fieldSchemaVersion: z.number().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  fields: z.record(z.unknown()),
  price: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  geoAreaId: z.string().nullable(),
  outsideBoundary: z.boolean(),
  ownershipResolution: z.string(),
  media: z.array(mediaSchema),
  showPhone: z.boolean(),
  allowChat: z.boolean(),
  isSold: z.boolean(),
  soldAt: z.string().nullable(),
  soldPrice: z.string().nullable(),
  publishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  bumpedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Only in the owner's and staff's view. */
  hiddenByOwner: z.boolean().optional(),
  moderationReason: z.string().nullable().optional(),
  isMine: z.boolean(),
});
export type PostView = z.infer<typeof postSchema>;
export class PostDto extends createZodDto(postSchema) {}

/** What a scrubbed post (ADR 006) looks like to anyone allowed to see it at all. */
export const scrubbedPostSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum(POST_STATUSES),
  scrubbed: z.literal(true),
  scrubbedAt: z.string(),
  isSold: z.boolean(),
});
export type ScrubbedPostView = z.infer<typeof scrubbedPostSchema>;

export const myPostsSchema = z.object({
  items: z.array(postSchema),
  nextCursor: z.string().nullable(),
});
export type MyPostsPage = z.infer<typeof myPostsSchema>;
export class MyPostsDto extends createZodDto(myPostsSchema) {}

export const ownershipSchema = z.object({
  tenantId: z.string(),
  resolution: z.enum(['inside_boundary', 'within_buffer', 'beyond_buffer_fallback', 'no_location']),
  outsideBoundary: z.boolean(),
  /** A beyond-buffer post always waits for a moderator, whatever the tenant's mode. */
  needsReview: z.boolean(),
});
export type OwnershipView = z.infer<typeof ownershipSchema>;
export class OwnershipDto extends createZodDto(ownershipSchema) {}

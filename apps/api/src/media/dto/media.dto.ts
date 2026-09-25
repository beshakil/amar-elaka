import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const presignMediaSchema = z
  .object({
    kind: z.enum(['image', 'video', 'document']),
    contentType: z.string().min(1),
    byteSize: z.number().int().positive(),
    // settings-exempt: a sha256 hex digest is always 64 characters — a protocol constant.
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex sha256 digest'),
  })
  .strict();
export type PresignMediaInput = z.infer<typeof presignMediaSchema>;
export class PresignMediaDto extends createZodDto(presignMediaSchema) {}

export const mediaIdParamSchema = z.object({ id: z.string().uuid() });
export class MediaIdParamDto extends createZodDto(mediaIdParamSchema) {}

export const presignedMediaSchema = z.object({
  /** The mediaId: confirm it, then attach it to a post/store. */
  id: z.string(),
  storageKey: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    expiresInSeconds: z.number(),
  }),
});
export type PresignedMedia = z.infer<typeof presignedMediaSchema>;
export class PresignedMediaDto extends createZodDto(presignedMediaSchema) {}

const variantSchema = z.object({ url: z.string(), width: z.number(), height: z.number() });

export const mediaStatusSchema = z.object({
  id: z.string(),
  status: z.enum(['pending_upload', 'processing', 'ready', 'rejected', 'quarantined']),
  kind: z.enum(['image', 'video', 'document']),
  mimeType: z.string(),
  byteSize: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** ThumbHash (base64) for a blurred placeholder while the image loads. */
  thumbhash: z.string().nullable(),
  /** Public images only, once ready. */
  variants: z.object({ thumb: variantSchema, card: variantSchema, full: variantSchema }).nullable(),
});
export type MediaStatus = z.infer<typeof mediaStatusSchema>;
export class MediaStatusDto extends createZodDto(mediaStatusSchema) {}

import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const createUploadSchema = z.object({
  kind: z.enum(['image', 'video', 'document']),
  contentType: z.string().min(1),
  byteSize: z.coerce.number().int().positive(),
  // settings-exempt: a sha256 hex digest is always 64 characters — a protocol constant, not a business threshold.
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex sha256 digest'),
});

export class CreateUploadDto extends createZodDto(createUploadSchema) {}

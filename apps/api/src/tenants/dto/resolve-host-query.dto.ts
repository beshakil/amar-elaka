import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const resolveHostQuerySchema = z.object({
  // settings-exempt: a hostname's maximum length is fixed by RFC 1035, not a business threshold.
  host: z.string().min(1).max(253),
});

export class ResolveHostQueryDto extends createZodDto(resolveHostQuerySchema) {}

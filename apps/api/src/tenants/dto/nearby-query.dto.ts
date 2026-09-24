import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const nearbyQuerySchema = z.object({
  // settings-exempt: latitude's fixed geographic range, not a business threshold.
  lat: z.coerce.number().min(-90).max(90),
  // settings-exempt: longitude's fixed geographic range, not a business threshold.
  lng: z.coerce.number().min(-180).max(180),
});

export class NearbyQueryDto extends createZodDto(nearbyQuerySchema) {}

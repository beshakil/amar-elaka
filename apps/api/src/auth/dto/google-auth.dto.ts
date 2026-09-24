import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { deviceSchema } from './device.schema';

export const googleAuthSchema = z.object({
  idToken: z.string().min(1),
  device: deviceSchema,
});

export class GoogleAuthDto extends createZodDto(googleAuthSchema) {}

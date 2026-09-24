import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { deviceSchema } from './device.schema';

export const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  device: deviceSchema,
});

export class EmailLoginDto extends createZodDto(emailLoginSchema) {}

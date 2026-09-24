import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { phoneSchema } from './phone.schema';

export const otpRequestSchema = z.object({ phone: phoneSchema });

export class OtpRequestDto extends createZodDto(otpRequestSchema) {}

import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { deviceSchema } from './device.schema';
import { phoneSchema } from './phone.schema';

// Shape check only — the real length (otp_code_length) is a platform setting,
// not something a static zod schema can read; OtpService compares hashes,
// so a code of the wrong length simply never matches.
const codeSchema = z.string().regex(/^\d{4,8}$/, 'Enter the code exactly as received.');

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: codeSchema,
  device: deviceSchema,
});

export class OtpVerifyDto extends createZodDto(otpVerifySchema) {}

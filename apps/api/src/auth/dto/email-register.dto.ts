import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

// The real minimum (auth_password_min_length) is a platform setting; this is
// just a structural non-empty check, enforced properly in AuthService.
export const emailRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export class EmailRegisterDto extends createZodDto(emailRegisterSchema) {}

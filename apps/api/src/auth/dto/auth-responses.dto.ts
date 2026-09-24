import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { APP_ROLES } from '../../database/tenant-context';

/**
 * Response shapes, defined once — see tenants/dto/tenant-responses.dto.ts for
 * why the service types are inferred from these rather than declared beside
 * them.
 */

export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type SessionTokens = z.infer<typeof sessionTokensSchema>;
export class SessionTokensDto extends createZodDto(sessionTokensSchema) {}

export const meResultSchema = z.object({
  userId: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  avatarStorageKey: z.string().nullable(),
  tenantId: z.string(),
  memberId: z.string(),
  role: z.enum(APP_ROLES),
});
export type MeResult = z.infer<typeof meResultSchema>;
export class MeResultDto extends createZodDto(meResultSchema) {}

/** `POST /auth/google` while signed in links the account instead of signing in. */
export class GoogleLinkedDto extends createZodDto(z.object({ linked: z.literal(true) })) {}

export class OtpSentDto extends createZodDto(z.object({ status: z.literal('otp_sent') })) {}
export class EmailLinkedDto extends createZodDto(z.object({ status: z.literal('linked') })) {}
export class LoggedOutDto extends createZodDto(z.object({ status: z.literal('logged_out') })) {}

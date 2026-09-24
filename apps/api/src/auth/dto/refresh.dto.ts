import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export class RefreshDto extends createZodDto(refreshSchema) {}

export const logoutSchema = z.object({ refreshToken: z.string().min(1) });

export class LogoutDto extends createZodDto(logoutSchema) {}

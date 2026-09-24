import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

export const assignRoleSchema = z
  .object({
    roleCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    customRoleId: z.string().uuid().optional(),
  })
  .refine((body) => Boolean(body.roleCode) !== Boolean(body.customRoleId), {
    message: 'Provide exactly one of roleCode or customRoleId.',
  });

export class AssignRoleDto extends createZodDto(assignRoleSchema) {}

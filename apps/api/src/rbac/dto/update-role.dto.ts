import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { roleGrantsSchema, roleNameSchema } from './create-role.dto';

/**
 * Either field may change on its own. `permissions` replaces the whole matrix
 * rather than patching it: the admin UI always sends the full set it shows,
 * and a replace is the only form that can also remove a grant.
 */
export const updateRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    permissions: roleGrantsSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.permissions !== undefined, {
    message: 'Provide name, permissions, or both.',
  });

export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

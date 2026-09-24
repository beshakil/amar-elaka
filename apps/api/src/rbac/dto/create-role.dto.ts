import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

const actionSchema = z.enum(['read', 'write', 'approve', 'delete', '*']);
// Mirrors role_permissions_module_ck (infra/migrations/0015_rbac.sql).
const moduleSchema = z.union([z.literal('*'), z.string().regex(/^[a-z][a-z0-9_]*$/)]);

// settings-exempt: a generic input-length cap, not a business threshold.
export const roleNameSchema = z.string().trim().min(1).max(100);

export const roleGrantsSchema = z
  .array(
    z.object({
      module: moduleSchema,
      action: actionSchema,
    }),
  )
  .min(1);

export const createRoleSchema = z.object({
  name: roleNameSchema,
  permissions: roleGrantsSchema,
});

export class CreateRoleDto extends createZodDto(createRoleSchema) {}

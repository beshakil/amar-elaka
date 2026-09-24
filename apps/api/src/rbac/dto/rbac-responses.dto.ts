import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { APP_ROLES } from '../../database/tenant-context';

/**
 * Response shapes, defined once — see tenants/dto/tenant-responses.dto.ts for
 * why the service types are inferred from these rather than declared beside
 * them.
 */

export const grantSchema = z.object({ module: z.string(), action: z.string() });
export type Grant = z.infer<typeof grantSchema>;

export const effectivePermissionsSchema = z.object({
  isPlatformAdmin: z.boolean(),
  grants: z.array(grantSchema),
});
export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;

/** `GET /me/permissions`: the effective grants plus the caller's role in this tenant. */
export const myPermissionsSchema = effectivePermissionsSchema.extend({
  role: z.enum(APP_ROLES).optional(),
});
export type MyPermissions = z.infer<typeof myPermissionsSchema>;
export class MyPermissionsDto extends createZodDto(myPermissionsSchema) {}

export const roleWithPermissionsSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  isBuiltin: z.boolean(),
  permissions: z.array(grantSchema),
});
export type RoleWithPermissions = z.infer<typeof roleWithPermissionsSchema>;
export class RoleDto extends createZodDto(roleWithPermissionsSchema) {}

export class RoleAssignedDto extends createZodDto(z.object({ status: z.literal('assigned') })) {}

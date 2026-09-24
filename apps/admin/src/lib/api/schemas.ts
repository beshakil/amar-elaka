import type { components } from '@amar-elaka/shared-types';
import { z } from 'zod';

/**
 * Runtime checks for the API responses this app reads. The types come from the
 * zod schemas, and the assertions at the bottom tie each one to the API's
 * published OpenAPI type — so a shape change in the API, once `pnpm gen:api`
 * regenerates the types, fails this app's typecheck instead of failing at
 * runtime. A schema may read fewer fields than the API sends; it may not read
 * one the API does not send, or read it as the wrong type.
 */

export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type SessionTokens = z.infer<typeof sessionTokensSchema>;

export const tenantSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  districtNameBn: z.string().nullable(),
  districtNameEn: z.string().nullable(),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

/** Matches PermissionsService's EffectivePermissions plus MeController's `role`. */
export const grantSchema = z.object({ module: z.string(), action: z.string() });
export type Grant = z.infer<typeof grantSchema>;

export const effectivePermissionsSchema = z.object({
  isPlatformAdmin: z.boolean(),
  grants: z.array(grantSchema),
  role: z.string().optional(),
});
export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;

/** Matches AuthService's MeResult. */
export const meSchema = z.object({
  userId: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  avatarStorageKey: z.string().nullable(),
  tenantId: z.string(),
  memberId: z.string(),
  role: z.string(),
});
export type Me = z.infer<typeof meSchema>;

/** Matches RolesRepository's RoleWithPermissions. */
export const roleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  isBuiltin: z.boolean(),
  permissions: z.array(grantSchema),
});
export type Role = z.infer<typeof roleSchema>;

type Api = components['schemas'];
/** True when every value the API may send is one this app's schema accepts. */
type Accepts<Local, Published> = [Published] extends [Local] ? true : false;
type Assert<T extends true> = T;

export type _ApiContract = [
  Assert<Accepts<SessionTokens, Api['SessionTokensDto']>>,
  Assert<Accepts<TenantSummary, Api['TenantSummaryDto']>>,
  Assert<Accepts<EffectivePermissions, Api['MyPermissionsDto']>>,
  Assert<Accepts<Me, Api['MeResultDto']>>,
  Assert<Accepts<Role, Api['RoleDto']>>,
];

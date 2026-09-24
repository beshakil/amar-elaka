'use server';

import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import { roleSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

// Mirrors CreateRoleDto/UpdateRoleDto (apps/api/src/rbac/dto) so the client
// refuses what the server would refuse.
const roleName = z.string().trim().min(1).max(100); // settings-exempt: generic input cap matching the API DTO
const roleGrants = z
  .array(
    z.object({
      module: z.union([z.literal('*'), z.string().regex(/^[a-z][a-z0-9_]*$/)]),
      action: z.enum(['read', 'write', 'approve', 'delete', '*']),
    }),
  )
  .min(1);

const roleInput = z.object({ name: roleName, permissions: roleGrants });
const roleId = z.string().uuid();

export type RoleInput = z.infer<typeof roleInput>;

/** Resolves the message key here, on the server, where the typed error still exists. */
async function run(
  call: (session: { tenantId: string; accessToken: string }) => Promise<unknown>,
): Promise<ActionResult> {
  // Tokens live in httpOnly cookies, so only the server can attach them —
  // which is why these are actions rather than client-side fetches.
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await call(session);
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

export async function createRole(input: RoleInput): Promise<ActionResult> {
  const parsed = roleInput.safeParse(input);
  if (!parsed.success) return { ok: false, messageKey: 'validationFailed' };

  return run((session) =>
    apiFetch({
      path: '/roles',
      method: 'POST',
      schema: roleSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      body: parsed.data,
    }),
  );
}

export async function updateRole(id: string, input: RoleInput): Promise<ActionResult> {
  const parsedId = roleId.safeParse(id);
  const parsed = roleInput.safeParse(input);
  if (!parsedId.success || !parsed.success) return { ok: false, messageKey: 'validationFailed' };

  return run((session) =>
    apiFetch({
      path: `/roles/${parsedId.data}`,
      method: 'PATCH',
      schema: roleSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      body: parsed.data,
    }),
  );
}

export async function deleteRole(id: string): Promise<ActionResult> {
  const parsedId = roleId.safeParse(id);
  if (!parsedId.success) return { ok: false, messageKey: 'validationFailed' };

  return run((session) =>
    apiFetch({
      path: `/roles/${parsedId.data}`,
      method: 'DELETE',
      // 204 No Content.
      schema: z.null(),
      tenantId: session.tenantId,
      accessToken: session.accessToken,
    }),
  );
}

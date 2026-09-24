import { z } from 'zod';
import { apiFetch } from '@/lib/api/fetch';
import { roleSchema } from '@/lib/api/schemas';
import { hasGrant } from '@/lib/auth/me';
import { requireGrant } from '@/lib/auth/guards';
import { RolesClient } from './roles-client';

export default async function RolesPage() {
  // Also enforced by ./layout.tsx, which is what makes a denial a real 404.
  const viewer = await requireGrant({ module: 'roles', action: 'read' });

  const roles = await apiFetch({
    path: '/roles',
    schema: z.array(roleSchema),
    tenantId: viewer.session.tenantId,
    accessToken: viewer.session.accessToken,
  });

  // The modules a role can be granted are whatever the built-in roles already
  // use — read off real data rather than a list in the frontend that would
  // quietly drift from the API's own matrix (infra/migrations/0015_rbac.sql).
  const modules = [
    ...new Set(roles.flatMap((role) => role.permissions.map((grant) => grant.module))),
  ]
    .filter((module) => module !== '*')
    .sort();

  // Decided here, from the viewer's real grants; the API enforces the same
  // rules, this only keeps the page from offering what would be refused.
  const abilities = {
    canWrite: hasGrant(viewer.permissions, { module: 'roles', action: 'write' }),
    canDelete: hasGrant(viewer.permissions, { module: 'roles', action: 'delete' }),
  };

  return <RolesClient roles={roles} modules={['*', ...modules]} abilities={abilities} />;
}

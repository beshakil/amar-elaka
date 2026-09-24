import { cache } from 'react';
import { redirect } from 'next/navigation';
import { apiFetch } from '../api/fetch';
import {
  effectivePermissionsSchema,
  meSchema,
  type EffectivePermissions,
  type Me,
} from '../api/schemas';
import { readSession, type Session } from './session';

export interface Viewer {
  session: Session;
  me: Me;
  permissions: EffectivePermissions;
}

/**
 * The signed-in operator, their identity and their effective grants. Cached per
 * request so a layout, a sidebar and a page all share one pair of calls.
 *
 * Middleware already redirected anyone without cookies; this redirects too,
 * because a token can be rejected between the two (revoked, tenant switched)
 * and a dashboard must never render half-authenticated.
 */
export const currentViewer = cache(async (): Promise<Viewer> => {
  const session = await readSession();
  if (!session) redirect('/login');

  const [me, permissions] = await Promise.all([
    apiFetch({
      path: '/auth/me',
      schema: meSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
    }),
    apiFetch({
      path: '/me/permissions',
      schema: effectivePermissionsSchema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
    }),
  ]);

  return { session, me, permissions };
});

/** True when the viewer holds a grant, honouring the API's `*` wildcards. */
export function hasGrant(
  permissions: EffectivePermissions,
  required: { module: string; action: string },
): boolean {
  if (permissions.isPlatformAdmin) return true;
  return permissions.grants.some(
    (grant) =>
      (grant.module === '*' || grant.module === required.module) &&
      (grant.action === '*' || grant.action === required.action),
  );
}

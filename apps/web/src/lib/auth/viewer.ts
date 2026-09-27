import type { Route } from 'next';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { apiFetch } from '../api/fetch';
import { meSchema, type Me } from '../api/schemas';
import { currentTenantId } from '../tenant';
import { readSession, type Session } from './session';

export interface Viewer {
  me: Me;
  session: Session;
  tenantId: string;
}

/**
 * The signed-in seller for a page that needs one. middleware.ts already sent
 * a visitor without a session to /login; this is the page's own check (a
 * session the API no longer accepts also goes back to login, with `next`).
 */
export const requireViewer = cache(async (): Promise<Viewer> => {
  const [session, tenantId, requestHeaders] = await Promise.all([
    readSession(),
    currentTenantId(),
    headers(),
  ]);
  const here = requestHeaders.get('x-pathname') ?? '/';
  const toLogin = `/login?next=${encodeURIComponent(here)}` as Route;
  if (!session || !tenantId) redirect(toLogin);
  try {
    const me = await apiFetch({
      path: '/auth/me',
      schema: meSchema,
      tenantId,
      accessToken: session.accessToken,
    });
    return { me, session, tenantId };
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status: number }).status === 401
    ) {
      redirect(toLogin);
    }
    throw error;
  }
});

import type { Route } from 'next';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { apiFetch } from '../api/fetch';
import { banNoticesSchema, meSchema, type BanNotice, type Me } from '../api/schemas';
import { currentTenantId } from '../tenant';
import { readSession, type Session } from './session';

export interface Viewer {
  me: Me;
  session: Session;
  tenantId: string;
  /** The account's bans (ADR 063): a restricted seller sees a banner; a banned one never gets here. */
  bans: BanNotice[];
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
    const auth = { tenantId, accessToken: session.accessToken };
    const [me, bans] = await Promise.all([
      apiFetch({ path: '/auth/me', schema: meSchema, ...auth }),
      apiFetch({ path: '/account/bans', schema: banNoticesSchema, ...auth }),
    ]);
    // Banned: nothing but the notice and the appeal answers (schema.md §9.10).
    if (bans.items.some((b) => b.severity !== 'restricted')) redirect('/account/bans');
    return { me, session, tenantId, bans: bans.items };
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

'use server';

import { cookies } from 'next/headers';
import { SIDEBAR_COOKIE, SIDEBAR_COOKIE_MAX_AGE } from '@/lib/ui-preferences';

export async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
  (await cookies()).set(SIDEBAR_COOKIE, collapsed ? '1' : '0', {
    path: '/',
    maxAge: SIDEBAR_COOKIE_MAX_AGE,
    sameSite: 'lax',
  });
}

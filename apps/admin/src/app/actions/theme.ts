'use server';

import { cookies } from 'next/headers';
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, type ThemePreference } from '@/lib/ui-preferences';

export async function setThemePreference(preference: ThemePreference): Promise<void> {
  (await cookies()).set(THEME_COOKIE, preference, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: 'lax',
  });
}

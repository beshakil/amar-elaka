import { cookies } from 'next/headers';

export const SIDEBAR_COOKIE = 'ae_sidebar';
export const THEME_COOKIE = 'ae_theme';

// A year: a layout preference should outlive the session, not a business rule.
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const THEME_COOKIE_MAX_AGE = SIDEBAR_COOKIE_MAX_AGE;

export type ThemePreference = 'light' | 'dark' | 'system';

export function isThemePreference(value: string | undefined): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Both preferences are read on the server so the shell renders at the right
 * width, in the right palette, in the first byte of HTML — no post-hydration
 * correction to see.
 */
export async function readUiPreferences(): Promise<{
  sidebarCollapsed: boolean;
  theme: ThemePreference;
}> {
  const store = await cookies();
  const theme = store.get(THEME_COOKIE)?.value;
  return {
    sidebarCollapsed: store.get(SIDEBAR_COOKIE)?.value === '1',
    theme: isThemePreference(theme) ? theme : 'system',
  };
}

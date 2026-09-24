import { cookies } from 'next/headers';

export const THEME_COOKIE = 'theme';

export type ThemePreference = 'light' | 'dark' | 'system';

// A year — long enough that a returning visitor keeps their choice; not a
// business rule.
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemePreference(value: string | undefined): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Read server-side so `<html data-theme>` is correct in the first byte of
 * HTML — no client-side flash, and no blocking inline script to avoid one.
 */
export async function readThemePreference(): Promise<ThemePreference> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return isThemePreference(value) ? value : 'system';
}

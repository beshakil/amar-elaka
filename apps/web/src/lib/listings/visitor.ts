import type { NextRequest, NextResponse } from 'next/server';

/**
 * A browser's own random id (cookie `ae_install`), sent to the API as
 * `X-Install-Id` so a guest's views and contact reveals are counted once
 * per browser (ADR 036) — this server makes the API calls, so without it
 * every guest would look like one visitor. Not tied to an account.
 */
export const INSTALL_COOKIE = 'ae_install';
// A long-lived, per-browser id: its lifetime is a cookie setting, not a business rule.
const INSTALL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2;

export function installId(request: NextRequest): { id: string; isNew: boolean } {
  const existing = request.cookies.get(INSTALL_COOKIE)?.value;
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return { id: existing, isNew: false };
  return { id: crypto.randomUUID().replaceAll('-', ''), isNew: true };
}

export function rememberInstallId(response: NextResponse, id: string): void {
  response.cookies.set(INSTALL_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: INSTALL_COOKIE_MAX_AGE,
  });
}

/** The visitor's headers for the API: install id and their own address. */
export function visitorHeaders(request: NextRequest, install: string): Record<string, string> {
  const forwarded = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  return {
    'X-Install-Id': install,
    ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}),
    ...(request.headers.get('user-agent')
      ? { 'User-Agent': request.headers.get('user-agent')! }
      : {}),
  };
}

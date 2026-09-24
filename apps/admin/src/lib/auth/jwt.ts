/**
 * Reads an access token's `exp` without verifying it. This is only ever used to
 * decide whether to refresh before making a call — the API verifies the
 * signature on every request, so a forged token gains nothing here.
 */
export function accessTokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;

  try {
    const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== 'object' || claims === null) return null;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Refresh a little before the token actually lapses so a request in flight does
// not land on the far side of the boundary.
const EXPIRY_SKEW_MS = 30_000;

export function isAccessTokenExpired(token: string, now = Date.now()): boolean {
  const expiresAt = accessTokenExpiresAt(token);
  return expiresAt === null || expiresAt - EXPIRY_SKEW_MS <= now;
}

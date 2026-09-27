import { createHmac } from 'node:crypto';

/** What identifies one viewer across requests, strongest first. */
export interface ViewerSignals {
  userId: string | undefined;
  /** The app's or browser's own random install id (X-Install-Id), if sent. */
  installId: string | undefined;
  ip: string;
  userAgent: string | undefined;
}

/** An install id is opaque; this only keeps junk and huge values out of Redis keys. */
const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A stable, non-reversible key for one viewer: the signed-in user, else the
 * install id, else IP + user agent. Keyed with a server secret (HMAC), so a
 * stored key (lead_events.anon_session_hash, Redis) can't be turned back
 * into a user id or an IP by hashing guesses.
 */
export function viewerKey(secret: string, viewer: ViewerSignals): string {
  const identity = viewer.userId
    ? `user:${viewer.userId}`
    : viewer.installId && INSTALL_ID.test(viewer.installId)
      ? `install:${viewer.installId}`
      : `ip:${viewer.ip}|ua:${viewer.userAgent ?? ''}`;
  return createHmac('sha256', secret).update(identity).digest('hex');
}

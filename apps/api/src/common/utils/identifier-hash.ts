import { createHmac } from 'node:crypto';

/**
 * The blacklist's phone identifier (ADR 063): an HMAC under the server-side
 * identifier pepper (NID_HASH_SECRET, ADR 062), domain-separated from NID
 * hashes. A blacklist entry outlives the account, so it keeps this, never the
 * number itself.
 */
export function phoneHash(phoneE164: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`phone:${phoneE164}`).digest('hex');
}

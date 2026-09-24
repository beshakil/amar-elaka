import { describe, expect, it } from 'vitest';
import { accessTokenExpiresAt, isAccessTokenExpired } from './jwt';

const token = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('access token expiry', () => {
  it('reads exp (seconds) as milliseconds', () => {
    expect(accessTokenExpiresAt(token({ exp: 1_000 }))).toBe(1_000_000);
  });

  it('is expired within the 30s safety margin, not only after exp', () => {
    const now = 1_000_000;
    expect(isAccessTokenExpired(token({ exp: (now + 60_000) / 1000 }), now)).toBe(false);
    expect(isAccessTokenExpired(token({ exp: (now + 10_000) / 1000 }), now)).toBe(true);
  });

  it('treats anything unreadable as expired, so it gets refreshed rather than trusted', () => {
    expect(isAccessTokenExpired('not-a-jwt')).toBe(true);
    expect(isAccessTokenExpired(token({ sub: 'no-exp' }))).toBe(true);
    expect(isAccessTokenExpired('h.%%%.sig')).toBe(true);
  });
});

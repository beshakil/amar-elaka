import { searcherHash } from './searcher-hash';

const SECRET = 'test-secret-0123456789';
const anon = { userId: undefined, installId: undefined, ip: '203.0.113.7', userAgent: 'ua' };
const DAY_1 = new Date('2026-09-28T01:00:00Z');
const LATER_DAY_1 = new Date('2026-09-28T23:00:00Z');
const DAY_2 = new Date('2026-09-29T01:00:00Z');

describe('searcherHash', () => {
  it('is stable for one searcher within a day, and 64 hex characters', () => {
    expect(searcherHash(SECRET, anon, DAY_1)).toBe(searcherHash(SECRET, anon, LATER_DAY_1));
    expect(searcherHash(SECRET, anon, DAY_1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes daily, and differs between searchers', () => {
    expect(searcherHash(SECRET, anon, DAY_1)).not.toBe(searcherHash(SECRET, anon, DAY_2));
    expect(searcherHash(SECRET, anon, DAY_1)).not.toBe(
      searcherHash(SECRET, { ...anon, ip: '203.0.113.8' }, DAY_1),
    );
  });

  it('follows a signed-in user across devices, and depends on the secret', () => {
    const user = { ...anon, userId: '0191e3a0-0000-7000-8000-000000000001' };
    expect(searcherHash(SECRET, user, DAY_1)).toBe(
      searcherHash(SECRET, { ...user, ip: '198.51.100.1', userAgent: 'other' }, DAY_1),
    );
    expect(searcherHash(SECRET, user, DAY_1)).not.toBe(
      searcherHash('another-secret-0123', user, DAY_1),
    );
  });
});

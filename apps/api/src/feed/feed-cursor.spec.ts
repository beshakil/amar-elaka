import { decodeFeedCursor, encodeFeedCursor, feedQueryKey } from './feed-cursor';
import { FeedCursorInvalidException } from './feed.exceptions';

const KEY = feedQueryKey({ scope: 'area', category: null, filters: null, radius: 5 });
const CURSOR = {
  k: KEY,
  at: Date.UTC(2026, 8, 27, 6, 0, 0),
  o: { lat: 24.05, lng: 90.06 },
  r: 5,
  p: { s: 0.7342198765432101, id: '0191e3a0-d15c-7000-8000-000000000101' },
  s: { d: 1234.5678, id: '0191e3a0-d15c-7000-8000-000000000201' },
  n: 20,
};

describe('feed cursor', () => {
  it('round-trips, keeping the score exact', () => {
    const decoded = decodeFeedCursor(encodeFeedCursor(CURSOR), KEY);
    expect(decoded).toEqual({ v: 1, ...CURSOR });
    expect(decoded.p.s).toBe(CURSOR.p.s);
  });

  it('is URL-safe', () => {
    expect(encodeFeedCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor from another query', () => {
    const other = feedQueryKey({ scope: 'nearby', category: null, filters: null, radius: 5 });
    expect(() => decodeFeedCursor(encodeFeedCursor(CURSOR), other)).toThrow(
      FeedCursorInvalidException,
    );
  });

  it('rejects garbage and tampered shapes', () => {
    expect(() => decodeFeedCursor('not-a-cursor', KEY)).toThrow(FeedCursorInvalidException);
    const tampered = Buffer.from(JSON.stringify({ v: 1, ...CURSOR, extra: 1 })).toString(
      'base64url',
    );
    expect(() => decodeFeedCursor(tampered, KEY)).toThrow(FeedCursorInvalidException);
  });

  it('keys queries independently of property order', () => {
    expect(feedQueryKey({ a: 1, b: 'x' })).toBe(feedQueryKey({ b: 'x', a: 1 }));
    expect(feedQueryKey({ a: 1 })).not.toBe(feedQueryKey({ a: 2 }));
  });
});

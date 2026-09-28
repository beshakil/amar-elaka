import { SearchCursorInvalidException } from '../search.exceptions';
import { decodeSearchCursor, encodeSearchCursor, searchDigest } from './search-cursor';

describe('search cursor', () => {
  const key = searchDigest({ q: 'daktar', scope: 'area', limit: 20 });

  it('round-trips the offset for the same search', () => {
    expect(decodeSearchCursor(encodeSearchCursor(key, 40), key)).toBe(40);
  });

  it('refuses a cursor from another search, or anything malformed', () => {
    const other = searchDigest({ q: 'doctor', scope: 'area', limit: 20 });
    const cursor = encodeSearchCursor(key, 20);
    expect(() => decodeSearchCursor(cursor, other)).toThrow(SearchCursorInvalidException);
    for (const bad of ['', 'x', Buffer.from('{"v":1,"k":"x","o":1}').toString('base64url')]) {
      expect(() => decodeSearchCursor(bad, key)).toThrow(SearchCursorInvalidException);
    }
    const negative = Buffer.from(JSON.stringify({ v: 1, k: key, o: -5 })).toString('base64url');
    expect(() => decodeSearchCursor(negative, key)).toThrow(SearchCursorInvalidException);
  });

  it('digests parameters regardless of key order, treating undefined as null', () => {
    expect(searchDigest({ a: 1, b: undefined })).toBe(searchDigest({ b: null, a: 1 }));
    expect(searchDigest({ a: 1 })).not.toBe(searchDigest({ a: 2 }));
    expect(searchDigest({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

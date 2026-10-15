import { hashNid, normalizeNid } from './nid';

describe('the NID number', () => {
  it('normalises Bengali digits, spaces and dashes; accepts 10, 13 and 17 digits', () => {
    expect(normalizeNid('১২৩৪ ৫৬৭ ৮৯০')).toBe('1234567890');
    expect(normalizeNid('1990-2695-1234-5')).toBe('1990269512345');
    expect(normalizeNid('19902695123456789')).toBe('19902695123456789');
  });

  it('refuses anything else', () => {
    expect(normalizeNid('12345')).toBeUndefined();
    expect(normalizeNid('12345678901')).toBeUndefined();
    expect(normalizeNid('12345abc90')).toBeUndefined();
    expect(normalizeNid('')).toBeUndefined();
  });

  it('keeps a peppered hash and the last 3 digits — never the number', () => {
    const pepper = 'test-pepper-0123456789abcdef0123456789';
    const { hash, last3 } = hashNid('1234567890', pepper);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('1234567890');
    expect(last3).toBe('890');
    // Same number, same hash (duplicates are found); another pepper, another hash.
    expect(hashNid('1234567890', pepper).hash).toBe(hash);
    expect(hashNid('1234567890', `${pepper}x`).hash).not.toBe(hash);
  });
});

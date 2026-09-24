import { normalizeBdPhone } from './phone-normalizer';

describe('normalizeBdPhone', () => {
  it('normalizes the local 01XXXXXXXXX form', () => {
    expect(normalizeBdPhone('01712345678')).toBe('+8801712345678');
  });

  it('normalizes the 8801XXXXXXXXX form', () => {
    expect(normalizeBdPhone('8801712345678')).toBe('+8801712345678');
  });

  it('normalizes the already-E.164 +8801XXXXXXXXX form', () => {
    expect(normalizeBdPhone('+8801712345678')).toBe('+8801712345678');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBdPhone('  01712345678  ')).toBe('+8801712345678');
  });

  it.each(['01212345678', '0171234567', '017123456789', 'not-a-phone', ''])(
    'rejects %s',
    (input) => {
      expect(normalizeBdPhone(input)).toBeUndefined();
    },
  );
});

import { checkContactInfo } from './contact-filter';

describe('checkContactInfo (ADR 058)', () => {
  it('lets a clean message through', () => {
    expect(checkContactInfo('দাম কত?', 0, 6)).toEqual({ outcome: 'clean' });
  });

  it.each([
    ['01711223344', 'phone'],
    ['+880 1711-223344', 'phone'],
    ['০১৭১১ ২২৩ ৩৪৪', 'phone'], // Bengali digits, split by spaces
    ['www.example.com', 'link'],
    ['দেখুন bit.ly/abc', 'link'],
  ] as const)('holds back %s within the window (%s)', (text, found) => {
    expect(checkContactInfo(text, 2, 6)).toEqual({ outcome: 'blocked', found, remaining: 4 });
  });

  it('a phone number wins over a link when both are there', () => {
    expect(checkContactInfo('01711223344 www.example.com', 0, 1)).toMatchObject({ found: 'phone' });
  });

  it('flags instead of holding back once the window is over', () => {
    expect(checkContactInfo('01711223344', 6, 6)).toEqual({ outcome: 'flagged' });
  });

  it('a tenant that set 0 never holds back, but still flags', () => {
    expect(checkContactInfo('01711223344', 0, 0)).toEqual({ outcome: 'flagged' });
  });
});

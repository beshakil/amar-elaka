import {
  containsPhoneNumber,
  countLinks,
  findBannedKeywords,
  isPriceOutlier,
  textFlags,
} from './prefilter';

const KEYWORDS = ['অগ্রিম টাকা', 'advance payment', 'বিকাশে আগে'];

describe('pre-filter', () => {
  describe('banned keywords', () => {
    it.each([
      ['অগ্রিম টাকা দিলে ফ্ল্যাট পাবেন', 'অগ্রিম টাকা'],
      ['ADVANCE PAYMENT required', 'advance payment'],
      ['Advance   payment only', 'advance payment'],
      ['অ-গ্রি-ম টা-কা লাগবে', 'অগ্রিম টাকা'], // split up to dodge a plain match
      ['a.d.v.a.n.c.e payment', 'advance payment'],
      ['বিকাশে‌আগে পাঠান', 'বিকাশে আগে'], // zero-width non-joiner
    ])('catches %p', (text, keyword) => {
      expect(findBannedKeywords(text, KEYWORDS)).toContain(keyword);
    });

    it('leaves ordinary posts alone', () => {
      expect(findBannedKeywords('মিরপুরে ২ রুমের ফ্ল্যাট ভাড়া, গ্যাস আছে', KEYWORDS)).toEqual([]);
      expect(findBannedKeywords('anything', [])).toEqual([]);
    });
  });

  describe('phone numbers typed into the text', () => {
    it.each([
      '01712345678',
      '+8801712345678',
      '০১৭১২৩৪৫৬৭৮', // Bengali digits
      '০১৭১২-৩৪৫ ৬৭৮', // Bengali digits, split
      'call 017 1234 5678 now',
      '01712.345.678',
    ])('finds %p', (text) => {
      expect(containsPhoneNumber(text)).toBe(true);
    });

    it.each(['Flat 1200 sqft, rent 15000', '2023 model, 12345678 km?', '01212345678'])(
      'does not mistake %p for a phone number',
      (text) => {
        expect(containsPhoneNumber(text)).toBe(false);
      },
    );
  });

  describe('links', () => {
    it('counts distinct URLs, www. and bare short-link domains', () => {
      expect(countLinks('see https://example.com/a and www.shop.com')).toBe(2);
      expect(countLinks('bit.ly/xyz fb.me/abc bit.ly/xyz')).toBe(2);
      expect(countLinks('no links, just 10.5 lakh')).toBe(0);
    });
  });

  it('flags a price far from the category median, in either direction', () => {
    expect(isPriceOutlier(60_000, 15_000, 5)).toBe(false); // within 5x: 3,000–75,000
    expect(isPriceOutlier(80_000, 15_000, 5)).toBe(true);
    expect(isPriceOutlier(2_000, 15_000, 5)).toBe(true);
    expect(isPriceOutlier(100, 0, 5)).toBe(false); // no norm yet
  });

  it('combines the text checks in a stable order', () => {
    expect(
      textFlags({
        title: 'অগ্রিম টাকা দিন',
        description: 'call ০১৭১২৩৪৫৬৭৮, see bit.ly/a and bit.ly/b',
        bannedKeywords: KEYWORDS,
        maxLinks: 1,
      }),
    ).toEqual(['banned_keyword', 'contact_info', 'link_spam']);
    expect(
      textFlags({
        title: 'ফ্ল্যাট ভাড়া',
        description: null,
        bannedKeywords: KEYWORDS,
        maxLinks: 1,
      }),
    ).toEqual([]);
  });
});

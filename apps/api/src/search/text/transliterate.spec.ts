import { normalizeSearchText, searchWords, splitByScript } from './normalize';
import { transliterate, transliterateWord, transliterationVariants } from './transliterate';

describe('normalizeSearchText', () => {
  it('composes to NFC, so both spellings of ো compare equal', () => {
    const typedAsTwoSigns = '\u09A6\u09C7\u09BE\u0995\u09BE\u09A8'; // দ + ে + া + কান
    expect(normalizeSearchText(typedAsTwoSigns)).toBe('\u09A6\u09CB\u0995\u09BE\u09A8'); // দোকান
  });

  it('drops zero-width joiners and non-joiners', () => {
    expect(normalizeSearchText('ডাক্‌তার')).toBe('ডাক্তার');
    expect(normalizeSearchText('র‍্যাব')).toBe('র্যাব');
  });

  it('turns the old khanda-ta spelling into ৎ', () => {
    expect(normalizeSearchText('বিদ্যুত্‌')).toBe('বিদ্যুৎ');
  });

  it('maps Bengali digits to ASCII and lower-cases Latin', () => {
    expect(normalizeSearchText('৩ রুম  FLAT')).toBe('3 রুম flat');
  });

  it('splits words at punctuation, including the danda', () => {
    expect(searchWords('ডাক্তার, চেম্বার। Dr. Rahim')).toEqual([
      'ডাক্তার',
      'চেম্বার',
      'dr',
      'rahim',
    ]);
    expect(splitByScript('Doctor মিরপুর 10')).toEqual({
      bengali: ['মিরপুর'],
      latin: ['doctor', '10'],
    });
  });
});

describe('transliterate (Bengali → Banglish)', () => {
  it.each([
    ['ডাক্তার', 'daktar'],
    ['ইলেকট্রিশিয়ান', 'ilektrishiyan'],
    ['বাসা', 'basa'],
    ['ভাড়া', 'bhara'],
    ['মিরপুর', 'mirpur'],
    ['সবজি', 'sobji'],
    ['করিম', 'korim'],
    ['কলম', 'kolom'],
    ['বাংলাদেশ', 'bangladesh'],
    ['চট্টগ্রাম', 'chottogram'],
    ['রাজশাহী', 'rajshahi'],
    ['মিস্ত্রি', 'mistri'],
    ['গাড়ি', 'gari'],
    ['দোকান', 'dokan'],
    ['হাসপাতাল', 'haspatal'],
    ['ঢাকা', 'dhaka'],
    ['শান্ত', 'shanto'],
    ['দেহ', 'deho'],
    ['চাকরি', 'chakri'],
  ])('%s → %s', (bengali, latin) => {
    expect(transliterate(bengali)).toBe(latin);
  });

  it('reads a misspelling without hasanta the same way', () => {
    expect(transliterateWord('ডাকতার')).toBe('daktar');
  });

  it('transliterates word by word and leaves Latin words alone', () => {
    expect(transliterate('ডাক্তার Rahim চেম্বার')).toBe('daktar rahim chembar');
  });

  it('never throws on stray signs', () => {
    expect(() => transliterate('্্া ঁ')).not.toThrow();
  });
});

describe('transliterationVariants', () => {
  it('offers the common alternative spellings, primary first', () => {
    expect(transliterationVariants('বাসা')).toEqual(['basa', 'basha']);
    expect(transliterationVariants('ভাড়া')).toEqual(expect.arrayContaining(['bhara', 'vara']));
    expect(transliterationVariants('সবজি')).toEqual(
      expect.arrayContaining(['sobji', 'shobji', 'sabji', 'sobzi']),
    );
    expect(transliterationVariants('করিম')).toContain('karim');
  });

  it('covers English loans spelt in Bengali', () => {
    expect(transliterationVariants('রেস্টুরেন্ট')).toContain('resturent');
    expect(transliterationVariants('ব্যাংক')).toContain('bank');
    expect(transliterationVariants('ফ্ল্যাট')).toContain('flat');
  });

  it('is bounded on long words', () => {
    expect(transliterationVariants('ময়মনসিংহ').length).toBeLessThanOrEqual(24);
  });
});

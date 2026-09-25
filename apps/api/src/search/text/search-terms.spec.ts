import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { cleanDisplayText, SearchTerms } from './search-terms';

describe('SearchTerms', () => {
  const terms = new SearchTerms(SYNONYM_LINES);

  it('indexes a Bengali name with its Banglish spelling, variants and English equivalents', () => {
    const fields = terms.nameFields({ title: 'ডাক্তার রহিম চেম্বার' });
    expect(fields).toMatchObject({
      name_bn: 'ডাক্তার রহিম চেম্বার',
      name_en: null,
      name_translit: 'daktar rohim chembar',
    });
    expect(fields.name_variants).toEqual(expect.arrayContaining(['doctor', 'rahim']));
    // The primary spelling is already in name_translit.
    expect(fields.name_variants).not.toContain('daktar');
  });

  it('meets the transliteration examples: ইলেকট্রিশিয়ান → electrician, বাসা → basa/basha', () => {
    expect(terms.nameFields({ title: 'ইলেকট্রিশিয়ান করিম' }).name_variants).toContain(
      'electrician',
    );
    const basa = terms.nameFields({ title: 'বাসা ভাড়া' });
    expect(basa.name_translit).toBe('basa bhara');
    expect(basa.name_variants).toEqual(expect.arrayContaining(['basha', 'vara', 'house', 'rent']));
  });

  it('matches multi-word dictionary phrases', () => {
    expect(terms.variants('ভালো দাঁতের ডাক্তার')).toContain('dentist');
  });

  it('puts a Latin title in name_en and keeps both names of a store', () => {
    expect(terms.nameFields({ title: 'Doctor Rahim Chamber' })).toMatchObject({
      name_bn: null,
      name_en: 'Doctor Rahim Chamber',
      name_translit: 'doctor rahim chamber',
      name_variants: [],
    });
    expect(terms.nameFields({ bn: 'রহিম ফার্মেসি', en: 'Rahim Pharmacy' })).toMatchObject({
      name_bn: 'রহিম ফার্মেসি',
      name_en: 'Rahim Pharmacy',
      name_translit: 'rohim pharmesi',
    });
  });

  it('puts the Banglish spelling of a short Bengali query first', () => {
    expect(terms.expandQuery('ডাক্তার')).toBe('daktar ডাক্তার');
    expect(terms.expandQuery('doctor মিরপুর')).toBe('doctor mirpur মিরপুর');
    expect(terms.expandQuery('  Dakter ')).toBe('dakter');
  });

  it('leaves long queries alone', () => {
    const long = 'এক দুই তিন চার পাঁচ ছয় সাত';
    expect(terms.expandQuery(long)).toBe(long);
  });

  it('transliterates only the Bengali words of free text', () => {
    expect(terms.bengaliTranslit('Flat ফ্ল্যাট, lift আছে')).toBe('phlyat ache');
    expect(terms.bengaliTranslit('only latin')).toBeNull();
    expect(terms.bengaliTranslit(null)).toBeNull();
  });

  it('cleans display text without changing case or digits', () => {
    expect(cleanDisplayText('  ৩ Room‌  ফ্ল্যাট ')).toBe('৩ Room ফ্ল্যাট');
    expect(cleanDisplayText('   ')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { listingPath, listingSlug } from './slug';

describe('listingSlug', () => {
  it('keeps Bengali words, conjuncts included, and hyphenates the rest', () => {
    expect(listingSlug('স্যামসাং গ্যালাক্সি A54 — প্রায় নতুন!')).toBe(
      'স্যামসাং-গ্যালাক্সি-a54-প্রায়-নতুন',
    );
    expect(listingSlug('ক্ষুদ্র স্বর্ণের হার।')).toBe('ক্ষুদ্র-স্বর্ণের-হার');
  });

  it('normalizes to NFC, so both spellings of য় give one slug', () => {
    const decomposed = 'প্রায়';
    expect(listingSlug(decomposed)).toBe(listingSlug('প্রায়'));
  });

  it('drops zero-width joiners', () => {
    expect(listingSlug('র‍্যাব')).toBe('র্যাব');
    expect(listingSlug('ক‌্ষ')).toBe('ক্ষ');
  });

  it('cuts a long title at a word boundary, at most 80 characters', () => {
    const slug = listingSlug('বাসা '.repeat(40));
    expect([...slug].length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('বাসা')).toBe(true);
  });

  it('is never empty', () => {
    expect(listingSlug('!!! ...')).toBe('listing');
  });
});

describe('listingPath', () => {
  it('percent-encodes the slug', () => {
    expect(listingPath('0191e3a0-0000-7000-8000-000000000001', 'নতুন ফোন')).toBe(
      `/listing/0191e3a0-0000-7000-8000-000000000001/${encodeURIComponent('নতুন-ফোন')}`,
    );
  });
});

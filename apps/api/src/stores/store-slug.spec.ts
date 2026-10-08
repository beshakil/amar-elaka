import { storeSlugFromName, storeSlugProblem, withSlugSuffix } from './store-slug';

describe('store slugs (ADR 054)', () => {
  it('spells a Bengali name in Latin letters', () => {
    expect(storeSlugFromName('রহিম স্টোর', null)).toBe('rohim-stor');
    expect(storeSlugFromName('মায়ের দোয়া ফার্মেসী', undefined)).toBe('mayer-doya-pharmesi');
  });

  it('prefers the English name when there is one', () => {
    expect(storeSlugFromName('রহিম স্টোর', 'Rahim & Sons Store')).toBe('rahim-sons-store');
  });

  it('falls back to the Bengali name when the English one has nothing to spell', () => {
    expect(storeSlugFromName('রহিম স্টোর', '★★')).toBe('rohim-stor');
  });

  it('is never empty, too short or reserved', () => {
    expect(storeSlugFromName('★', null)).toBe('store');
    expect(storeSlugFromName('ক', null)).toMatch(/^store-/);
    expect(storeSlugFromName('মি', 'me')).not.toBe('me');
    for (const slug of [storeSlugFromName('মি', 'me'), storeSlugFromName('★', null)]) {
      expect(storeSlugProblem(slug)).toBeNull();
    }
  });

  it('cuts long names at a word boundary within 60 characters', () => {
    const slug = storeSlugFromName(
      'দোকান',
      'the very long name of a shop that sells everything under the sun',
    );
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toMatch(/-$/);
    expect(storeSlugProblem(slug)).toBeNull();
  });

  it('adds a short random tail and stays valid', () => {
    const slug = withSlugSuffix('rohim-stor', () => 'A1B2C3D4');
    expect(slug).toBe('rohim-stor-a1b2');
    expect(storeSlugProblem(withSlugSuffix('x'.repeat(60), () => 'abcd'))).toBeNull();
  });

  it('explains why a chosen slug is refused', () => {
    expect(storeSlugProblem('ab')).toBe('length');
    expect(storeSlugProblem('Rahim_Store')).toBe('format');
    expect(storeSlugProblem('rahim--store')).toBe('format');
    expect(storeSlugProblem('রহিম')).toBe('format');
    expect(storeSlugProblem('me')).toBe('length');
    expect(storeSlugProblem('review-queue')).toBe('reserved');
    expect(storeSlugProblem('rahim-store')).toBeNull();
  });
});

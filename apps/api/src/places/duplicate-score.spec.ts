import { classifyDuplicate, duplicateScore, type DuplicateWeights } from './duplicate-score';

const WEIGHTS: DuplicateWeights = {
  likelyScore: 0.8,
  possibleScore: 0.45,
  phoneBonus: 0.4,
  categoryMismatchFactor: 0.7,
};
const near = { distanceM: 20, sameCategory: true, phoneMatch: false };

describe('duplicateScore / classifyDuplicate', () => {
  it('two spellings of one name are a possible duplicate; with the same phone, a likely one', () => {
    const spelling = duplicateScore({ ...near, nameSimilarity: 0.62 }, WEIGHTS);
    expect(classifyDuplicate(spelling, WEIGHTS)).toBe('possible');
    const withPhone = duplicateScore({ ...near, nameSimilarity: 0.62, phoneMatch: true }, WEIGHTS);
    expect(withPhone).toBe(1);
    expect(classifyDuplicate(withPhone, WEIGHTS)).toBe('likely');
  });

  it('an identical name is likely; different names are nothing', () => {
    expect(
      classifyDuplicate(duplicateScore({ ...near, nameSimilarity: 1 }, WEIGHTS), WEIGHTS),
    ).toBe('likely');
    expect(
      classifyDuplicate(duplicateScore({ ...near, nameSimilarity: 0.09 }, WEIGHTS), WEIGHTS),
    ).toBeNull();
  });

  it('a different category scales the score down', () => {
    const score = duplicateScore({ ...near, nameSimilarity: 1, sameCategory: false }, WEIGHTS);
    expect(score).toBe(0.7);
    expect(classifyDuplicate(score, WEIGHTS)).toBe('possible');
  });

  it('stores have no category: not penalised', () => {
    expect(duplicateScore({ ...near, nameSimilarity: 0.9, sameCategory: null }, WEIGHTS)).toBe(0.9);
  });

  it('a shared phone alone is a possible duplicate', () => {
    const score = duplicateScore({ ...near, nameSimilarity: 0.1, phoneMatch: true }, WEIGHTS);
    expect(classifyDuplicate(score, WEIGHTS)).toBe('possible');
  });
});

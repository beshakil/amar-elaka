import {
  bayesianRating,
  computeSellerScore,
  tierOf,
  type SellerScoreInputs,
  type SellerScoreSettings,
} from './seller-score-formula';

// The seeded defaults (0057).
const settings: SellerScoreSettings = {
  priorMean: 4.0,
  priorWeight: 10,
  weightRating: 45,
  weightResponseRate: 15,
  weightResponseTime: 10,
  weightAccountAge: 10,
  weightVerification: 20,
  penaltyPerUpheldReport: 5,
  responseTargetMinutes: 60,
  responseMaxMinutes: 1440,
  minConversations: 5,
  accountAgeFullMonths: 24,
  minReviewsForTier: 3,
  tierTop: 85,
  tierTrusted: 70,
  tierGood: 50,
};
const now = new Date('2026-10-11T00:00:00Z');
const base: SellerScoreInputs = {
  ratingSum: 0,
  ratingCount: 0,
  conversations: 20,
  answered: 20,
  medianReplySeconds: 30 * 60,
  storeCreatedAt: new Date('2024-01-01T00:00:00Z'),
  verificationLevel: 'business',
  upheldReports: 0,
};
const reviews = (count: number, average: number): SellerScoreInputs => ({
  ...base,
  ratingCount: count,
  ratingSum: count * average,
});

describe('Bayesian smoothing', () => {
  it('one 5-star review does not beat fifty 4.6s', () => {
    const one = bayesianRating(5, 1, settings.priorMean, settings.priorWeight);
    const fifty = bayesianRating(50 * 4.6, 50, settings.priorMean, settings.priorWeight);
    expect(fifty).toBeGreaterThan(one);
    expect(computeSellerScore(reviews(50, 4.6), settings, now).score).toBeGreaterThan(
      computeSellerScore(reviews(1, 5), settings, now).score,
    );
  });

  it('with no reviews it is the prior; with many it approaches the real average', () => {
    expect(bayesianRating(0, 0, 4, 10)).toBe(4);
    expect(bayesianRating(1000 * 2, 1000, 4, 10)).toBeCloseTo(2.02, 2);
  });

  it('a prior weight of 0 is the plain average', () => {
    expect(bayesianRating(9, 2, 4, 0)).toBe(4.5);
  });

  it('ordering follows evidence: more good reviews rank above fewer perfect ones', () => {
    const ranked = [reviews(1, 5), reviews(3, 5), reviews(50, 4.6), reviews(200, 4.4)].map((i) =>
      bayesianRating(i.ratingSum, i.ratingCount, settings.priorMean, settings.priorWeight),
    );
    expect(ranked[2]).toBeGreaterThan(ranked[0]!);
    expect(ranked[2]).toBeGreaterThan(ranked[1]!);
    expect(ranked[3]).toBeGreaterThan(ranked[0]!);
  });
});

describe('the score', () => {
  it('a long-standing, verified, responsive five-star store scores near the top', () => {
    const r = computeSellerScore(reviews(100, 5), settings, now);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.tier).toBe('top');
  });

  it('every component uses its weight; an upheld report costs its penalty', () => {
    const clean = computeSellerScore(reviews(20, 4.5), settings, now);
    const reported = computeSellerScore({ ...reviews(20, 4.5), upheldReports: 2 }, settings, now);
    expect(clean.score - reported.score).toBe(10);
    expect(clean.components.verification).toBe(20);
    expect(clean.components.account_age).toBe(10);
  });

  it('slow replies earn nothing for time; few chats earn half', () => {
    const slow = computeSellerScore(
      { ...reviews(10, 4), medianReplySeconds: 2 * 24 * 3600 },
      settings,
      now,
    );
    expect(slow.components.response_time).toBe(0);
    const quiet = computeSellerScore(
      { ...reviews(10, 4), conversations: 2, answered: 0 },
      settings,
      now,
    );
    expect(quiet.components.response_rate).toBe(7.5);
    expect(quiet.components.response_time).toBe(5);
  });

  it('stays within 0–100', () => {
    const worst = computeSellerScore(
      {
        ...reviews(10, 1),
        answered: 0,
        verificationLevel: 'none',
        upheldReports: 50,
        storeCreatedAt: now,
      },
      settings,
      now,
    );
    expect(worst.score).toBe(0);
  });

  it('weights come from settings: zeroing the rating weight removes its effect', () => {
    const s = { ...settings, weightRating: 0 };
    expect(computeSellerScore(reviews(10, 1), s, now).score).toBe(
      computeSellerScore(reviews(10, 5), s, now).score,
    );
  });
});

describe('tiers', () => {
  it('too few reviews: new, whatever the score', () => {
    expect(tierOf(99, 2, settings)).toBe('new');
  });
  it('by threshold, and none below good', () => {
    expect(tierOf(85, 10, settings)).toBe('top');
    expect(tierOf(70, 10, settings)).toBe('trusted');
    expect(tierOf(50, 10, settings)).toBe('good');
    expect(tierOf(49, 10, settings)).toBe('none');
  });
});

import { computeTrust, type TrustInputs, type TrustWeights } from './trust-formula';

const WEIGHTS: TrustWeights = {
  base: 20,
  perApprovedPost: 5,
  maxApprovedPoints: 40,
  perRejectedPost: 8,
  perRemovedPost: 15,
  perUpheldReport: 10,
  perAccountMonth: 2,
  maxAccountAgePoints: 15,
  phoneVerified: 10,
  storeVerified: 15,
  perBan: 30,
};
const NOW = new Date('2026-09-25T00:00:00Z');
const fresh: TrustInputs = {
  approvedPosts: 0,
  rejectedPosts: 0,
  removedPosts: 0,
  upheldReports: 0,
  bans: 0,
  phoneVerified: false,
  storeVerified: false,
  memberSince: NOW,
};

describe('trust formula', () => {
  it('starts a brand-new member at the base score', () => {
    expect(computeTrust(fresh, WEIGHTS, NOW).score).toBe(20);
  });

  it('adds verified phone, store, history and age — each capped', () => {
    const { score, components } = computeTrust(
      {
        ...fresh,
        approvedPosts: 20, // 100 → capped at 40
        phoneVerified: true,
        storeVerified: true,
        memberSince: new Date('2025-09-25T00:00:00Z'), // 12 months → 24, capped at 15
      },
      WEIGHTS,
      NOW,
    );
    expect(components).toMatchObject({
      approved_posts: 40,
      account_age: 15,
      phone_verified: 10,
      store_verified: 15,
    });
    expect(score).toBe(100);
  });

  it('subtracts rejections, removals, upheld reports and bans, never below 0', () => {
    const { score, components } = computeTrust(
      { ...fresh, phoneVerified: true, rejectedPosts: 1, removedPosts: 1, upheldReports: 1 },
      WEIGHTS,
      NOW,
    );
    expect(components).toMatchObject({
      rejected_posts: -8,
      removed_posts: -15,
      upheld_reports: -10,
    });
    expect(score).toBe(0); // 20 + 10 - 8 - 15 - 10 = -3 → 0
    expect(computeTrust({ ...fresh, bans: 5 }, WEIGHTS, NOW).score).toBe(0);
  });
});

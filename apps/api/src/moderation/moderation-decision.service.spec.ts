import type { DatabaseTransaction } from '../database/database.client';
import type { SettingsService } from '../settings/settings.service';
import { ModerationDecisionService, type SubmissionFacts } from './moderation-decision.service';
import type { ModerationRepository } from './moderation.repository';

const SETTINGS: Record<string, unknown> = {
  trust_auto_approve_threshold: 60,
  moderation_sample_rate_percent: 0,
  moderation_banned_keywords: ['অগ্রিম টাকা'],
  moderation_max_links_per_post: 1,
  moderation_duplicate_window_hours: 24,
  moderation_price_outlier_factor: 5,
  moderation_price_min_samples: 10,
  moderation_price_lookback_days: 90,
};

function setup(overrides: Record<string, unknown> = {}, repo: Partial<ModerationRepository> = {}) {
  const settings = {
    get: (key: string) => Promise.resolve({ ...SETTINGS, ...overrides }[key]),
  } as unknown as SettingsService;
  const fakeRepo = {
    hasDuplicate: () => Promise.resolve(false),
    priceMedian: () => Promise.resolve({ median: 15_000, samples: 50 }),
    ...repo,
  } as unknown as ModerationRepository;
  return new ModerationDecisionService(fakeRepo, settings);
}

const tx = {} as DatabaseTransaction;
const facts = (overrides: Partial<SubmissionFacts> = {}): SubmissionFacts => ({
  tenantId: 't',
  postId: 'p',
  authorMemberId: 'm',
  title: 'মিরপুরে ফ্ল্যাট ভাড়া',
  description: 'গ্যাস, লিফট আছে',
  categoryId: 'c',
  price: '15000.00',
  forced: [],
  trustScore: 20,
  ...overrides,
});

describe('moderation decision on submit', () => {
  it("holds a new (low-trust) member's clean post", async () => {
    expect(await setup().decide(tx, facts())).toEqual({
      status: 'pending',
      reasons: ['low_trust'],
      sampled: false,
    });
  });

  it("publishes a trusted member's clean post", async () => {
    expect(await setup().decide(tx, facts({ trustScore: 80 }))).toEqual({
      status: 'live',
      reasons: [],
      sampled: false,
    });
  });

  it('holds a trusted member whose post trips the pre-filter, with the reasons', async () => {
    const decision = await setup().decide(
      tx,
      facts({ trustScore: 95, title: 'অগ্রিম টাকা দিয়ে বুকিং' }),
    );
    expect(decision).toEqual({ status: 'pending', reasons: ['banned_keyword'], sampled: false });
  });

  it('holds duplicates and price outliers', async () => {
    const decision = await setup({}, { hasDuplicate: () => Promise.resolve(true) }).decide(
      tx,
      facts({ trustScore: 95, price: '900000.00' }),
    );
    expect(decision.reasons).toEqual(['duplicate', 'price_outlier']);
  });

  it('checks prices only once the category has enough samples', async () => {
    const thin = setup({}, { priceMedian: () => Promise.resolve({ median: 15_000, samples: 3 }) });
    expect((await thin.decide(tx, facts({ trustScore: 95, price: '900000.00' }))).status).toBe(
      'live',
    );
  });

  it('always holds forced-review posts, whatever the score', async () => {
    const decision = await setup().decide(
      tx,
      facts({ trustScore: 100, forced: ['pre_moderation'] }),
    );
    expect(decision).toEqual({ status: 'pending', reasons: ['pre_moderation'], sampled: false });
  });

  it('samples auto-approved posts at the configured rate', async () => {
    expect(
      (await setup({ moderation_sample_rate_percent: 100 }).decide(tx, facts({ trustScore: 80 })))
        .sampled,
    ).toBe(true);
    expect(
      (await setup({ moderation_sample_rate_percent: 0 }).decide(tx, facts({ trustScore: 80 })))
        .sampled,
    ).toBe(false);
  });
});

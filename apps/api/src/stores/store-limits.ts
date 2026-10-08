import type { SettingKey } from '../settings/settings.registry';

/** store_tiers (0050). Paid tiers arrive in week 17; until then every store is basic. */
export const STORE_TIERS = ['basic', 'pro', 'premium'] as const;
export type StoreTier = (typeof STORE_TIERS)[number];

const STAFF_MAX = {
  basic: 'store_staff_max_basic',
  pro: 'store_staff_max_pro',
  premium: 'store_staff_max_premium',
} as const satisfies Record<StoreTier, SettingKey>;

const CATALOG_MAX = {
  basic: 'store_catalog_max_basic',
  pro: 'store_catalog_max_pro',
  premium: 'store_catalog_max_premium',
} as const satisfies Record<StoreTier, SettingKey>;

/** A tier code from the database; anything unknown counts as basic (the safe, smallest limits). */
export function asStoreTier(code: string): StoreTier {
  return (STORE_TIERS as readonly string[]).includes(code) ? (code as StoreTier) : 'basic';
}

/** The setting holding how many staff (invited or accepted) a store of this tier may have. */
export function staffLimitKey(tier: StoreTier): (typeof STAFF_MAX)[StoreTier] {
  return STAFF_MAX[tier];
}

/** The setting holding how many posts (draft, in review, live) a store of this tier may hold. */
export function catalogLimitKey(tier: StoreTier): (typeof CATALOG_MAX)[StoreTier] {
  return CATALOG_MAX[tier];
}

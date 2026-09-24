/**
 * Partner, tenants, and people. "5 users with different roles" (the ask)
 * are the five named, role-labelled accounts below; a further pool of
 * generic community members is seeded alongside them because 30 posts, 10
 * stores and 10 blood donors need more distinct authors than 5 people can
 * realistically supply without tripping one-row-per-member constraints
 * (e.g. blood_donors' one-donor-per-member shape). The five named accounts
 * are what demonstrates the role system; the pool is realistic filler.
 */

export const TENANT_SLUGS = {
  mirpur: 'mirpur',
  trishal: 'trishal',
} as const;

export const NAMED_USERS = [
  {
    key: 'platform-admin',
    phone: '+8801700000001',
    name: 'Platform Admin',
    platformRole: 'platform_admin' as const,
  },
  { key: 'tenant-admin', phone: '+8801700000002', name: 'Tenant Admin', platformRole: null },
  { key: 'moderator', phone: '+8801700000003', name: 'Moderator', platformRole: null },
  { key: 'seller', phone: '+8801700000004', name: 'Seller', platformRole: null },
  { key: 'buyer', phone: '+8801700000005', name: 'Buyer', platformRole: null },
] as const;

/** Realistic Bangladeshi names for the filler community-member pool. */
export const COMMUNITY_MEMBER_NAMES = [
  'Karim Sheikh',
  'Rahima Begum',
  'Jamal Hossain',
  'Nasrin Akter',
  'Habibur Rahman',
  'Salma Khatun',
  'Anwar Hossain',
  'Fatema Begum',
  'Rafiqul Islam',
  'Shirin Akter',
  'Mizanur Rahman',
  'Ayesha Siddika',
  'Kamal Uddin',
  'Rokeya Begum',
  'Shahidul Islam',
  'Momtaz Begum',
  'Delwar Hossain',
  'Nazma Khatun',
  'Abdul Malek',
  'Ruma Akter',
] as const;

export const BAZAR_COMMODITIES = [
  {
    code: 'rice-coarse',
    nameBn: 'মোটা চাল',
    nameEn: 'Coarse Rice',
    group: 'rice_grains',
    unit: 'kg',
  },
  { code: 'potato', nameBn: 'আলু', nameEn: 'Potato', group: 'vegetables', unit: 'kg' },
  { code: 'onion', nameBn: 'পেঁয়াজ', nameEn: 'Onion', group: 'vegetables', unit: 'kg' },
  {
    code: 'egg-farm',
    nameBn: 'ফার্মের ডিম',
    nameEn: 'Farm Egg',
    group: 'meat_eggs',
    unit: 'dozen',
  },
  {
    code: 'broiler-chicken',
    nameBn: 'ব্রয়লার মুরগি',
    nameEn: 'Broiler Chicken',
    group: 'meat_eggs',
    unit: 'kg',
  },
] as const;

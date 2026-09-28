/** Fixture identities shared by the stub API and the tests that drive it. */
export const STUB_PORT = Number(process.env.STUB_PORT ?? 4010);
export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

export const TENANT_MIRPUR = '0191e3a0-0000-7000-8000-000000000001';
export const TENANT_SAVAR = '0191e3a0-0000-7000-8000-000000000002';
export const PASSWORD = 'correct-horse';

/** The three kinds of operator the dashboard distinguishes. */
export const PERSONAS = {
  tenantAdmin: 'admin@mirpur.test',
  moderator: 'mod@mirpur.test',
  platformAdmin: 'root@platform.test',
  /** A seller on the public site, who signs in with a phone and an SMS code. */
  seller: 'seller@mirpur.test',
} as const;

/** The seller's phone, as typed, and the SMS code the stub accepts. */
export const SELLER_PHONE = '01711111111';
export const OTP_CODE = '123456';
export const PHONE_CATEGORY_ID = '0191e3a0-0000-7000-8000-00000000c001';

/** The one public store (in Mirpur) the stub serves at /stores/:slug. */
export const STORE_SLUG = 'rahim-electronics';

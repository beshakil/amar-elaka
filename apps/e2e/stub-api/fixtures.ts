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
} as const;

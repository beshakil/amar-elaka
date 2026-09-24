import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { PASSWORD, PERSONAS, STUB_URL, TENANT_MIRPUR } from '../stub-api/fixtures';

export const WEB = 'http://localhost:3001';
export const ADMIN = 'http://localhost:3002';
export const tenantUrl = (slug: string, path = '/') => `http://${slug}.localhost:3001${path}`;

/**
 * The web app's raw server response for a tenant host, fetched outside the
 * browser. Chromium resolves *.localhost to loopback by itself, but Node's
 * resolver does not, so the request goes to 127.0.0.1 with the tenant's Host.
 */
export async function serverResponse(
  request: APIRequestContext,
  host: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await request.get(`http://127.0.0.1:3001${path}`, { headers: { host, ...headers } });
  return { status: res.status(), body: await res.text() };
}

/** Drives the stub API's test-only control surface. */
export class Stub {
  constructor(private readonly request: APIRequestContext) {}

  async control(body: {
    reset?: boolean;
    down?: boolean;
    accessTtlSeconds?: number;
  }): Promise<void> {
    const res = await this.request.post(`${STUB_URL}/__control`, { data: body });
    expect(res.ok()).toBe(true);
  }

  async hits(key: string): Promise<number> {
    const res = await this.request.get(`${STUB_URL}/__stats`);
    const { hits } = (await res.json()) as { hits: Record<string, number> };
    return hits[key] ?? 0;
  }
}

export const test = base.extend<{ stub: Stub }>({
  // Every test starts from the same stub state: no custom roles, API up,
  // normal token lifetimes.
  stub: [
    async ({ request }, use) => {
      const stub = new Stub(request);
      await stub.control({ reset: true });
      await use(stub);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Signs in through the app's own login route handler — the same request the
 * login form makes — so the session cookies land in the browser context.
 * Tests about the login form itself drive the form instead.
 */
export async function signIn(page: Page, persona: keyof typeof PERSONAS): Promise<void> {
  const res = await page.request.post(`${ADMIN}/api/auth/login`, {
    data: { tenantId: TENANT_MIRPUR, email: PERSONAS[persona], password: PASSWORD },
  });
  expect(res.status()).toBe(200);
}

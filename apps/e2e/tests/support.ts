import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { components } from '@amar-elaka/shared-types';
import {
  OTP_CODE,
  PASSWORD,
  PERSONAS,
  SELLER_PHONE,
  STUB_URL,
  TENANT_MIRPUR,
} from '../stub-api/fixtures';

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
    sitemapUrlsPerFile?: number;
    seedPosts?: Partial<components['schemas']['PostDto']>[];
    areaMinListings?: number;
    savedSearchLimit?: boolean;
  }): Promise<{ posts: { id: string; title: string }[] }> {
    const res = await this.request.post(`${STUB_URL}/__control`, { data: body });
    expect(res.ok()).toBe(true);
    return (await res.json()) as { posts: { id: string; title: string }[] };
  }

  /** What the web sent: the last search's parameters and every saved search. */
  async searches(): Promise<{
    lastSearch: Record<string, string> | null;
    savedSearches: components['schemas']['CreateSavedSearchDto'][];
  }> {
    const res = await this.request.get(`${STUB_URL}/__stats`);
    return (await res.json()) as {
      lastSearch: Record<string, string> | null;
      savedSearches: components['schemas']['CreateSavedSearchDto'][];
    };
  }

  /** The posts the stub holds now (what the web app sent it). */
  async posts(): Promise<components['schemas']['PostDto'][]> {
    const res = await this.request.get(`${STUB_URL}/__stats`);
    return ((await res.json()) as { posts: components['schemas']['PostDto'][] }).posts;
  }

  /** The query of the last /search the web made (the category page's filters). */
  async lastSearch(): Promise<Record<string, string> | null> {
    const res = await this.request.get(`${STUB_URL}/__stats`);
    return ((await res.json()) as { lastSearch: Record<string, string> | null }).lastSearch;
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

/**
 * Signs a seller in on the public site the way a seller does — the login
 * page, phone, then the SMS code — so the session cookies land in the
 * browser for that area's host. (Not page.request: Node can't resolve
 * *.localhost the way Chromium does.)
 */
export async function signInSeller(page: Page, slug = 'mirpur'): Promise<void> {
  await page.goto(tenantUrl(slug, '/login?next=/me/posts'));
  await page.getByLabel('মোবাইল নম্বর').fill(SELLER_PHONE);
  await page.getByRole('button', { name: 'কোড পাঠান' }).click();
  await page.getByLabel('এসএমএস-এ পাওয়া কোড').fill(OTP_CODE);
  await page.getByRole('button', { name: 'লগইন করুন' }).click();
  await expect(page).toHaveURL(tenantUrl(slug, '/me/posts'));
}

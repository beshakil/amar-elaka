import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T1 = '0191e3a0-0000-7000-8000-000000000001';

// The gate keeps a module-level cache: every test loads a fresh copy.
async function gate() {
  vi.resetModules();
  return (await import('./public-gate')).publicPageGate;
}

const request = (path: string) =>
  new NextRequest(`http://mirpur.localhost:3001${path}`, {
    headers: { host: 'mirpur.localhost:3001' },
  });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const pairs = {
  minListings: 5,
  items: [
    {
      category: { slug: 'to-let', name: { bn: 'টু-লেট', en: 'To-Let' } },
      area: { slug: 'mirpur-10', name: { bn: 'মিরপুর ১০', en: 'Mirpur 10' } },
      count: 12,
    },
  ],
};

describe('category + area landing page gate (ADR 042)', () => {
  it('lets a published landing page render', async () => {
    fetchMock.mockResolvedValue(Response.json(pairs));
    const answer = await (await gate())(request('/category/to-let/mirpur-10'), new Headers(), T1);
    expect(answer).toBeNull();
    expect((fetchMock.mock.calls[0]?.[0] as string).endsWith('/seo/category-areas')).toBe(true);
  });

  it('404s an area below the threshold, and malformed segments without asking', async () => {
    fetchMock.mockResolvedValue(Response.json(pairs));
    const check = await gate();
    for (const path of [
      '/category/to-let/pallabi',
      '/category/mobile-phones/mirpur-10',
      '/category/to-let/Mirpur 10',
      '/category/to-let/mirpur-10/extra',
    ]) {
      expect((await check(request(path), new Headers(), T1))?.status).toBe(404);
    }
  });

  it('renders (never 404s) when the API cannot say', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const answer = await (await gate())(request('/category/to-let/mirpur-10'), new Headers(), T1);
    expect(answer).toBeNull();
  });
});

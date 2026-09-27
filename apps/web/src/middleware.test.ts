import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T1 = '0191e3a0-0000-7000-8000-000000000001';

// The middleware keeps a module-level resolve cache, so every test loads a
// fresh copy of the module.
async function load() {
  vi.resetModules();
  return (await import('./middleware')).middleware;
}

function request(host: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://${host}/`, { headers: { host, ...headers } });
}

/** Headers the middleware forwarded to the page (Next's override encoding). */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('web tenant-resolution middleware', () => {
  it('forwards the resolved tenant and asks the API with the browser hostname', async () => {
    fetchMock.mockResolvedValue(Response.json({ tenantId: T1 }));
    const res = await (await load())(request('mirpur.localhost:3001'));

    expect(forwarded(res, 'x-tenant-id')).toBe(T1);
    expect(forwarded(res, 'x-tenant-resolution')).toBe('resolved');
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe('/api/v1/tenants/resolve');
    expect(url.searchParams.get('host')).toBe('mirpur.localhost:3001');
  });

  it('marks a host with no tenant as none', async () => {
    fetchMock.mockResolvedValue(Response.json({ tenantId: null }));
    const res = await (await load())(request('nope.localhost:3001'));
    expect(forwarded(res, 'x-tenant-resolution')).toBe('none');
    expect(forwarded(res, 'x-tenant-id')).toBeNull();
  });

  it.each([
    ['a 5xx', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('marks %s as unavailable — not as "no tenant"', async (_, impl) => {
    fetchMock.mockImplementation(impl);
    const res = await (await load())(request('mirpur.localhost:3001'));
    expect(forwarded(res, 'x-tenant-resolution')).toBe('unavailable');
  });

  it('treats a 4xx (the API refusing the hostname) as a definite none', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const res = await (await load())(request('bad..host'));
    expect(forwarded(res, 'x-tenant-resolution')).toBe('none');
  });

  it('never forwards client-supplied tenant headers', async () => {
    fetchMock.mockResolvedValue(Response.json({ tenantId: null }));
    const res = await (
      await load()
    )(request('nope.localhost:3001', { 'x-tenant-id': T1, 'x-tenant-resolution': 'resolved' }));
    expect(forwarded(res, 'x-tenant-id')).toBeNull();
    expect(forwarded(res, 'x-tenant-resolution')).toBe('none');
  });

  it('caches a definite answer per hostname, case-insensitively', async () => {
    fetchMock.mockResolvedValue(Response.json({ tenantId: T1 }));
    const middleware = await load();
    await middleware(request('mirpur.localhost:3001'));
    await middleware(request('MIRPUR.localhost:3001'));
    await middleware(request('mirpur.localhost:3001'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once when the API could not answer', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ tenantId: T1 }));
    const res = await (await load())(request('mirpur.localhost:3001'));
    expect(forwarded(res, 'x-tenant-id')).toBe(T1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a definite answer', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    await (
      await load()
    )(request('mirpur.localhost:3001'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches unavailable — the next request asks again', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ tenantId: T1 }));
    const middleware = await load();
    const first = await middleware(request('mirpur.localhost:3001'));
    expect(forwarded(first, 'x-tenant-resolution')).toBe('unavailable');
    const res = await middleware(request('mirpur.localhost:3001'));
    expect(forwarded(res, 'x-tenant-id')).toBe(T1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('expires cached answers after the TTL', async () => {
    vi.useFakeTimers();
    try {
      // A fresh Response per call: a body can only be read once.
      fetchMock.mockImplementation(() => Promise.resolve(Response.json({ tenantId: T1 })));
      const middleware = await load();
      await middleware(request('mirpur.localhost:3001'));
      vi.advanceTimersByTime(61_000);
      const res = await middleware(request('mirpur.localhost:3001'));
      expect(forwarded(res, 'x-tenant-id')).toBe(T1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the cache, since Host is client-controlled', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ tenantId: null })));
    const middleware = await load();
    await middleware(request('first.test'));
    for (let i = 0; i < 1_000; i += 1) await middleware(request(`spray-${i}.test`));
    fetchMock.mockClear();
    await middleware(request('first.test'));
    // The oldest entry was evicted to stay within the bound, so it is asked again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** The URL a fetch call was made to (fetch takes a string, URL or Request). */
const urlOf = (input: string | URL | Request) =>
  input instanceof Request ? input.url : input.toString();

describe('seller-page gate', () => {
  const token = (secondsLeft: number) =>
    `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsLeft }))}.y`;
  const pageRequest = (path: string, cookie?: string) =>
    new NextRequest(`http://mirpur.localhost:3001${path}`, {
      headers: { host: 'mirpur.localhost:3001', ...(cookie ? { cookie } : {}) },
    });

  it('sends a visitor without a session to login, with next set to come back', async () => {
    fetchMock.mockResolvedValue(Response.json({ tenantId: T1 }));
    const res = await (await load())(pageRequest('/post/new'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/post/new');
  });

  it('lets a live session through, and leaves public pages alone', async () => {
    fetchMock.mockResolvedValue(Response.json({ tenantId: T1 }));
    const middleware = await load();
    const allowed = await middleware(
      pageRequest('/me/posts', `ae_access=${token(600)}; ae_refresh=r1`),
    );
    expect(allowed.headers.get('location')).toBeNull();
    const publicPage = await middleware(pageRequest('/listing/abc'));
    expect(publicPage.headers.get('location')).toBeNull();
  });

  it('rotates an expired access token on the way through', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).includes('/auth/refresh')
          ? Response.json({ accessToken: token(900), refreshToken: 'r2' })
          : Response.json({ tenantId: T1 }),
      ),
    );
    const res = await (
      await load()
    )(pageRequest('/post/new', `ae_access=${token(-10)}; ae_refresh=r1`));
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get('ae_refresh')?.value).toBe('r2');
    const refresh = fetchMock.mock.calls.find(([input]) => urlOf(input).includes('/auth/refresh'));
    expect((refresh?.[1]?.headers as Record<string, string>)['x-tenant-id']).toBe(T1);
  });

  it('a refused refresh goes to login and clears the cookies', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).includes('/auth/refresh')
          ? Response.json({ error: 'REFRESH_TOKEN_REUSED' }, { status: 401 })
          : Response.json({ tenantId: T1 }),
      ),
    );
    const res = await (
      await load()
    )(pageRequest('/me/posts', `ae_access=${token(-10)}; ae_refresh=r1`));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(res.cookies.get('ae_refresh')?.value).toBe('');
  });
});

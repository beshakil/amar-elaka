import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from './middleware';

const T1 = '0191e3a0-0000-7000-8000-000000000001';
const jwt = (expSecondsFromNow: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString('base64url')}.sig`;

function request(cookies: Record<string, string>, path = '/roles') {
  return new NextRequest(`http://localhost:3002${path}`, {
    headers: {
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('admin middleware', () => {
  it('lets a request with a live access token straight through, without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await middleware(request({ ae_access: jwt(600), ae_refresh: 'r', ae_tenant: T1 }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects to login with the original path when there is no session', async () => {
    const res = await middleware(request({}, '/roles'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3002/login?next=%2Froles');
  });

  it('rotates an expired access token and sets both new cookies httpOnly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ accessToken: jwt(900), refreshToken: 'r2' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await middleware(request({ ae_access: jwt(-10), ae_refresh: 'r1', ae_tenant: T1 }));

    expect(res.headers.get('x-middleware-next')).toBe('1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/refresh');
    expect(init.headers).toMatchObject({ 'x-tenant-id': T1 });
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'r1' });
    expect(res.cookies.get('ae_refresh')).toMatchObject({
      value: 'r2',
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(res.cookies.get('ae_access')?.httpOnly).toBe(true);
  });

  it('ends the session when rotation is refused (e.g. a replayed, spent refresh token)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const res = await middleware(
      request({ ae_access: jwt(-10), ae_refresh: 'spent', ae_tenant: T1 }),
    );
    expect(res.status).toBe(307);
    expect(res.cookies.get('ae_refresh')?.value).toBe('');
    expect(res.cookies.get('ae_access')?.value).toBe('');
  });

  it.each([
    ['unreachable', () => Promise.reject(new TypeError('fetch failed'))],
    ['returning 503', () => Promise.resolve(new Response(null, { status: 503 }))],
  ])(
    'keeps the session when the API is %s during rotation — the refresh token is unspent',
    async (_, impl) => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(impl));
      const res = await middleware(
        request({ ae_access: jwt(-10), ae_refresh: 'r1', ae_tenant: T1 }),
      );
      expect(res.headers.get('x-middleware-next')).toBe('1');
      expect(res.cookies.get('ae_refresh')).toBeUndefined();
      expect(res.cookies.get('ae_access')).toBeUndefined();
    },
  );
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiFetch, ApiError, ApiShapeError, ApiUnreachableError } from './fetch';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch (CLAUDE.md rule 5: timeout, retry, typed errors)', () => {
  it('sends tenant and bearer headers and returns the parsed body', async () => {
    const fetchMock = mockFetch(json(200, { id: 'r1', extra: true }));
    const result = await apiFetch({
      path: '/roles/r1',
      schema: z.object({ id: z.string() }),
      tenantId: 't1',
      accessToken: 'tok',
    });
    expect(result).toEqual({ id: 'r1' });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://api.test/api/v1/roles/r1');
    expect(init.headers).toMatchObject({ 'x-tenant-id': 't1', authorization: 'Bearer tok' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a GET once after a 5xx', async () => {
    const fetchMock = mockFetch(json(503, {}), json(200, { ok: true }));
    await expect(apiFetch({ path: '/x', schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a GET once after a network failure, then reports it as unreachable', async () => {
    const fetchMock = mockFetch(new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(apiFetch({ path: '/x', schema: z.unknown() })).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a POST — replaying a write could double it', async () => {
    const fetchMock = mockFetch(new TypeError('fetch failed'));
    await expect(
      apiFetch({ path: '/roles', method: 'POST', body: {}, schema: z.unknown() }),
    ).rejects.toBeInstanceOf(ApiUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns the API's error body into a typed ApiError carrying its code", async () => {
    mockFetch(json(409, { statusCode: 409, error: 'ROLE_ALREADY_EXISTS', message: 'dup' }));
    const error = await apiFetch({
      path: '/roles',
      method: 'POST',
      body: {},
      schema: z.unknown(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'ROLE_ALREADY_EXISTS' });
  });

  it('rejects a 2xx body of the wrong shape instead of passing it on', async () => {
    mockFetch(json(200, { id: 42 }));
    await expect(
      apiFetch({ path: '/x', schema: z.object({ id: z.string() }) }),
    ).rejects.toBeInstanceOf(ApiShapeError);
  });

  it('treats 204 as a null body', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(
      apiFetch({ path: '/roles/r1', method: 'DELETE', schema: z.null() }),
    ).resolves.toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiFetch, ApiError, ApiShapeError, ApiUnreachableError } from './fetch';

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch (CLAUDE.md rule 5: timeout, retry, typed errors)', () => {
  it("opts into Next's data cache only when asked to", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch({ path: '/tenant/config', schema: z.object({}), revalidate: 300 });
    await apiFetch({ path: '/tenant/config', schema: z.object({}) });
    const [first, second] = fetchMock.mock.calls.map(
      (call) => call[1] as RequestInit & { next?: unknown },
    );
    expect(first).toMatchObject({ next: { revalidate: 300 } });
    expect(second).toMatchObject({ cache: 'no-store' });
  });

  it('retries a GET once after a 5xx, then surfaces a typed ApiError', async () => {
    const error = { statusCode: 503, error: 'SERVICE_UNAVAILABLE', message: 'down' };
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json(error, { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch({ path: '/x', schema: z.unknown() }).catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeInstanceOf(ApiError);
    expect(result).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
  });

  it('reports an unreachable API as ApiUnreachableError, never a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(apiFetch({ path: '/x', schema: z.unknown() })).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
  });

  it('rejects a response of the wrong shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ slug: 1 })));
    await expect(
      apiFetch({ path: '/x', schema: z.object({ slug: z.string() }) }),
    ).rejects.toBeInstanceOf(ApiShapeError);
  });
});

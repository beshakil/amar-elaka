const store = new Map<string, string>();

const fakeRedis = {
  get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
  set: jest.fn((key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve('OK');
  }),
  del: jest.fn((key: string) => {
    store.delete(key);
    return Promise.resolve(1);
  }),
  disconnect: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => fakeRedis),
}));

import { CacheService } from './cache.service';

describe('CacheService', () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
  });

  function buildService(): CacheService {
    return new CacheService({ REDIS_URL: 'redis://localhost:6379' });
  }

  it('round-trips a JSON value', async () => {
    const cache = buildService();
    await cache.set('greeting', { text: 'হ্যালো' }, 60);
    await expect(cache.get<{ text: string }>('greeting')).resolves.toEqual({ text: 'হ্যালো' });
  });

  it('returns undefined for a missing key', async () => {
    const cache = buildService();
    await expect(cache.get('nope')).resolves.toBeUndefined();
  });

  it('del removes the key', async () => {
    const cache = buildService();
    await cache.set('x', 1, 60);
    await cache.del('x');
    await expect(cache.get('x')).resolves.toBeUndefined();
  });

  describe('remember', () => {
    it('calls load once on a miss and reuses the cached value on a hit', async () => {
      const cache = buildService();
      const load = jest.fn().mockResolvedValue('computed');

      await expect(cache.remember('key', 60, load)).resolves.toBe('computed');
      await expect(cache.remember('key', 60, load)).resolves.toBe('computed');

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('forTenant', () => {
    it('keeps two tenants’ identical keys separate', async () => {
      const cache = buildService();
      const tenantA = cache.forTenant('tenant-a');
      const tenantB = cache.forTenant('tenant-b');

      await tenantA.set('summary', 'a-value', 60);
      await tenantB.set('summary', 'b-value', 60);

      await expect(tenantA.get('summary')).resolves.toBe('a-value');
      await expect(tenantB.get('summary')).resolves.toBe('b-value');
    });
  });
});

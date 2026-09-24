import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';

export interface KeyValueCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Cache-aside: returns the cached value, or calls `load`, caches its result, and returns that. */
  remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
}

/**
 * General-purpose typed Redis cache for future callers. Deliberately
 * separate from the specialized stores this codebase already has
 * (RedisTenantCacheStore, RedisPermissionsCacheStore, RedisOtpStore) — each
 * of those has its own key scheme and semantics (sets, tenant-index
 * invalidation) that this doesn't try to generalize over; this is for a
 * plain "cache the result of this call" need.
 */
@Injectable()
export class CacheService implements KeyValueCache, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const value = await load();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /** A key-prefixed view over the same connection — one tenant's `orders-summary` never collides with another's. */
  forTenant(tenantId: string): KeyValueCache {
    const prefix = `cache:${tenantId}:`;
    return {
      get: (key) => this.get(prefix + key),
      set: (key, value, ttlSeconds) => this.set(prefix + key, value, ttlSeconds),
      del: (key) => this.del(prefix + key),
      remember: (key, ttlSeconds, load) => this.remember(prefix + key, ttlSeconds, load),
    };
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

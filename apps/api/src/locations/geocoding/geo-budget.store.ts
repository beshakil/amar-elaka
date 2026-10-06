import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

/**
 * Counters for paid provider calls (ADR 044), in Redis:
 *
 *   reserve   takes `cost` calls out of today's budget BEFORE the call is
 *             made, atomically (one Lua script): two requests can never both
 *             take the last call. Refused when it would go over; otherwise
 *             answers the day's new total (for the warning threshold).
 *   release   gives a reservation back, for a call that never reached the
 *             provider (so it can't have been billed).
 *   hit       a per-client rolling window (autocomplete, routes).
 *   once      true the first time a key is seen in its window (alerts:
 *             one per day per threshold).
 *
 * Every method returns null when Redis can't answer; the caller then counts
 * from geo_provider_calls instead (budget) or lets the request through
 * (per-client limit) — the daily budget still caps the spend.
 */
export type Reservation = { ok: true; total: number } | { ok: false };

export interface GeoBudgetStore {
  reserve(
    key: string,
    cost: number,
    budget: number,
    ttlSeconds: number,
  ): Promise<Reservation | null>;
  release(key: string, cost: number): Promise<void>;
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean | null>;
  once(key: string, ttlSeconds: number): Promise<boolean | null>;
}

export const GEO_BUDGET_STORE = Symbol('GEO_BUDGET_STORE');

// KEYS[1] counter; ARGV cost, budget, ttl. Returns the new total, or -1 when
// the cost would take it over the budget (nothing is added then).
const RESERVE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
if used + cost > tonumber(ARGV[2]) then return -1 end
local total = redis.call('INCRBY', KEYS[1], cost)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]), 'NX')
return total
`;

@Injectable()
export class RedisGeoBudgetStore implements GeoBudgetStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    // One quick try: a budget check must not hang a request when Redis is down.
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }

  async reserve(
    key: string,
    cost: number,
    budget: number,
    ttlSeconds: number,
  ): Promise<Reservation | null> {
    try {
      const total = (await this.client.eval(RESERVE, 1, key, cost, budget, ttlSeconds)) as number;
      return total >= 0 ? { ok: true, total } : { ok: false };
    } catch {
      return null;
    }
  }

  async release(key: string, cost: number): Promise<void> {
    try {
      await this.client.decrby(key, cost);
    } catch {
      // Losing a refund only makes the budget stricter.
    }
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean | null> {
    try {
      const [[, total]] = (await this.client
        .multi()
        .incr(key)
        .expire(key, windowSeconds, 'NX')
        .exec()) as [[Error | null, number], [Error | null, number]];
      return total <= limit;
    } catch {
      return null;
    }
  }

  async once(key: string, ttlSeconds: number): Promise<boolean | null> {
    try {
      return (await this.client.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch {
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';

/** A batch of view counts moved aside for the flush, by post id. */
export interface PendingViews {
  batchKey: string;
  counts: Map<string, number>;
}

/**
 * The Redis side of engagement (ADR 036): one-time claims (view and lead
 * dedupe), rolling-window counters (contact and report limits) and the
 * pending view counts the worker flushes to Postgres.
 */
export interface EngagementStore {
  /** True the first time `key` is claimed within `ttlSeconds`, false while the claim lasts. */
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
  /** Gives a claim back (the request was refused after claiming). */
  release(key: string): Promise<void>;
  /** Adds one to the counter at `key`, its window starting at first use; returns the total. */
  count(key: string, windowSeconds: number): Promise<number>;
  /** Takes one back off (a request refused after counting). */
  uncount(key: string): Promise<void>;
  /** One more view for the next flush. */
  addPendingView(postId: string): Promise<void>;
  /**
   * The next batch to flush: a batch an earlier run left unfinished first,
   * else the current pending counts, moved aside atomically so new views
   * land in a fresh hash. Null when there is nothing to flush.
   */
  takePendingViews(): Promise<PendingViews | null>;
  /** Drops flushed posts from the batch (and the batch once it's empty). */
  ackPendingViews(batchKey: string, postIds: readonly string[]): Promise<void>;
}

export const ENGAGEMENT_STORE = Symbol('ENGAGEMENT_STORE');

const PREFIX = 'eng:';
const PENDING = `${PREFIX}views:pending`;
const BATCHES = `${PREFIX}views:batches`;

// settings-exempt: the Lua script's key count (KEYS[1..3]), part of its signature
const TAKE_SCRIPT_KEYS = 3;
// RENAME + SADD in one step: a crash can't lose the batch between the two.
const TAKE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('RENAME', KEYS[1], KEYS[2])
redis.call('SADD', KEYS[3], KEYS[2])
return 1`;

@Injectable()
export class RedisEngagementStore implements EngagementStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const set = await this.client.set(PREFIX + key, '1', 'EX', ttlSeconds, 'NX');
    return set === 'OK';
  }

  async release(key: string): Promise<void> {
    await this.client.del(PREFIX + key);
  }

  async count(key: string, windowSeconds: number): Promise<number> {
    // INCR then EXPIRE NX in one round trip: the window starts at the first
    // use and later ones never extend it.
    const results = await this.client
      .multi()
      .incr(PREFIX + key)
      .expire(PREFIX + key, windowSeconds, 'NX')
      .exec();
    const total = results?.[0]?.[1];
    if (typeof total !== 'number') throw new Error('engagement store: INCR returned no count');
    return total;
  }

  async uncount(key: string): Promise<void> {
    await this.client.decr(PREFIX + key);
  }

  async addPendingView(postId: string): Promise<void> {
    await this.client.hincrby(PENDING, postId, 1);
  }

  async takePendingViews(): Promise<PendingViews | null> {
    const leftover = await this.client.srandmember(BATCHES);
    let batchKey = leftover;
    if (!batchKey) {
      const candidate = `${PREFIX}views:flushing:${randomUUID()}`;
      const moved = await this.client.eval(
        TAKE_SCRIPT,
        TAKE_SCRIPT_KEYS,
        PENDING,
        candidate,
        BATCHES,
      );
      if (moved !== 1) return null;
      batchKey = candidate;
    }
    const raw = await this.client.hgetall(batchKey);
    const counts = new Map<string, number>();
    for (const [postId, value] of Object.entries(raw)) {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) counts.set(postId, n);
    }
    if (counts.size === 0) {
      await this.client.multi().del(batchKey).srem(BATCHES, batchKey).exec();
      return this.takePendingViews();
    }
    return { batchKey, counts };
  }

  async ackPendingViews(batchKey: string, postIds: readonly string[]): Promise<void> {
    if (postIds.length > 0) await this.client.hdel(batchKey, ...postIds);
    if ((await this.client.hlen(batchKey)) === 0) {
      await this.client.multi().del(batchKey).srem(BATCHES, batchKey).exec();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

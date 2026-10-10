import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Chat's Redis state (ADR 058) — shared by every API instance, so nothing
 * here depends on which instance a socket or request landed on:
 *  - rolling-window counters for the per-user rate limits;
 *  - presence: who is viewing which conversation right now (a key with a
 *    TTL, refreshed by the client's heartbeat), so a viewer gets no
 *    notification for a message they are already looking at. A crashed
 *    instance's presence simply expires.
 */
export interface ChatStore {
  /** Adds one to the counter at `key`, its window starting at first use; returns the total. */
  count(key: string, windowSeconds: number): Promise<number>;
  /** Takes one back off (the request was refused or was a no-op after counting). */
  uncount(key: string): Promise<void>;
  markViewing(conversationId: string, userId: string, ttlSeconds: number): Promise<void>;
  stopViewing(conversationId: string, userId: string): Promise<void>;
  /** Of these users, the ones viewing the conversation. */
  viewers(conversationId: string, userIds: readonly string[]): Promise<Set<string>>;
}

export const CHAT_STORE = Symbol('CHAT_STORE');

const PREFIX = 'chat:';
const presenceKey = (conversationId: string, userId: string) =>
  `${PREFIX}viewing:${conversationId}:${userId}`;

@Injectable()
export class RedisChatStore implements ChatStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async count(key: string, windowSeconds: number): Promise<number> {
    // INCR then EXPIRE NX in one round trip: the window starts at the first
    // use and later ones never extend it (as the engagement store's counters).
    const full = `${PREFIX}${key}`;
    const results = await this.client.multi().incr(full).expire(full, windowSeconds, 'NX').exec();
    const total = results?.[0]?.[1];
    if (typeof total !== 'number') throw new Error('chat store: INCR returned no count');
    return total;
  }

  async uncount(key: string): Promise<void> {
    await this.client.decr(`${PREFIX}${key}`);
  }

  async markViewing(conversationId: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.client.set(presenceKey(conversationId, userId), '1', 'EX', ttlSeconds);
  }

  async stopViewing(conversationId: string, userId: string): Promise<void> {
    await this.client.del(presenceKey(conversationId, userId));
  }

  async viewers(conversationId: string, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const values = await this.client.mget(userIds.map((id) => presenceKey(conversationId, id)));
    return new Set(userIds.filter((_, index) => values[index] !== null));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') await this.client.quit().catch(() => undefined);
  }
}

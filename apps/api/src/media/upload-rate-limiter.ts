import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';

/** Rolling-window counters for per-user upload limits (media.service.ts). */
export interface UploadRateLimiter {
  /**
   * Adds `amount` to the counter at `key`, starting its window on first use,
   * and returns the new total.
   */
  add(key: string, amount: number, windowSeconds: number): Promise<number>;
  /** Takes `amount` back off, for a request that was refused after counting. */
  refund(key: string, amount: number): Promise<void>;
}

export const UPLOAD_RATE_LIMITER = Symbol('UPLOAD_RATE_LIMITER');

@Injectable()
export class RedisUploadRateLimiter implements UploadRateLimiter, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async add(key: string, amount: number, windowSeconds: number): Promise<number> {
    // INCRBY then EXPIRE NX in one round trip: the window starts at the first
    // upload and is never extended by later ones.
    const [[, total]] = (await this.client
      .multi()
      .incrby(key, amount)
      .expire(key, windowSeconds, 'NX')
      .exec()) as [[Error | null, number], [Error | null, number]];
    return total;
  }

  async refund(key: string, amount: number): Promise<void> {
    await this.client.decrby(key, amount);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import type { OtpRecord, OtpStore } from './otp-store.ports';

const CODE_HASH_FIELD = 'codeHash';
const ATTEMPTS_FIELD = 'attempts';

@Injectable()
export class RedisOtpStore implements OtpStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async createOtp(key: string, codeHash: string, ttlSeconds: number): Promise<void> {
    await this.client
      .multi()
      .hset(key, CODE_HASH_FIELD, codeHash, ATTEMPTS_FIELD, '0')
      .expire(key, ttlSeconds)
      .exec();
  }

  async getOtp(key: string): Promise<OtpRecord | undefined> {
    const raw = await this.client.hgetall(key);
    if (!raw[CODE_HASH_FIELD]) return undefined;
    return { codeHash: raw[CODE_HASH_FIELD], attempts: Number(raw[ATTEMPTS_FIELD] ?? 0) };
  }

  incrementAttempts(key: string): Promise<number> {
    return this.client.hincrby(key, ATTEMPTS_FIELD, 1);
  }

  async deleteOtp(key: string): Promise<void> {
    await this.client.del(key);
  }

  async trySetCooldown(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async incrementWindowedCounter(key: string, windowSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return count;
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

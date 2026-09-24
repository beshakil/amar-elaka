import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { PermissionsCacheStore } from './permissions-cache.ports';

@Injectable()
export class RedisPermissionsCacheStore implements PermissionsCacheStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.del(...keys);
  }

  async addToSet(setKey: string, member: string): Promise<void> {
    await this.client.sadd(setKey, member);
  }

  membersOfSet(setKey: string): Promise<string[]> {
    return this.client.smembers(setKey);
  }

  async deleteSet(setKey: string): Promise<void> {
    await this.client.del(setKey);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

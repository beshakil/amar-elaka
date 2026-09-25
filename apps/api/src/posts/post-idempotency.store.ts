import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import {
  IdempotencyKeyReusedException,
  IdempotentRequestInProgressException,
} from './posts.exceptions';

const recordSchema = z.union([
  z.object({ state: z.literal('pending'), hash: z.string() }),
  z.object({ state: z.literal('done'), hash: z.string(), postId: z.string() }),
]);

export type IdempotencyStart = { kind: 'new' } | { kind: 'replay'; postId: string };

export interface PostIdempotencyStore {
  /** Claims `key` for this request, or reports the post an earlier identical request made. */
  begin(key: string, requestHash: string, ttlSeconds: number): Promise<IdempotencyStart>;
  complete(key: string, requestHash: string, postId: string, ttlSeconds: number): Promise<void>;
  /** The request failed: free the key so a retry can run again. */
  release(key: string): Promise<void>;
}

export const POST_IDEMPOTENCY_STORE = Symbol('POST_IDEMPOTENCY_STORE');

/**
 * Idempotency-Key for POST /posts, in Redis. On a flaky mobile connection
 * the app retries a create it never heard back from; the same key and the
 * same body must return the same post, never a second one.
 *
 * - first request: SET NX a `pending` marker, create, then store the post id;
 * - identical retry after success: the stored post (200, not a new 201);
 * - identical retry while the first is still running: 409, try again;
 * - same key, different body: 422 (a client bug, not a retry).
 *
 * Keys are scoped per user by the caller, so one user can't replay another's.
 */
@Injectable()
export class RedisPostIdempotencyStore implements PostIdempotencyStore, OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'REDIS_URL'>) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true });
  }

  async begin(key: string, requestHash: string, ttlSeconds: number): Promise<IdempotencyStart> {
    const claimed = await this.client.set(
      key,
      JSON.stringify({ state: 'pending', hash: requestHash }),
      'EX',
      ttlSeconds,
      'NX',
    );
    if (claimed === 'OK') return { kind: 'new' };

    const raw = await this.client.get(key);
    // Expired between the two calls: claim it again.
    if (raw === null) return this.begin(key, requestHash, ttlSeconds);
    const record = recordSchema.safeParse(JSON.parse(raw));
    if (!record.success) throw new IdempotentRequestInProgressException();
    if (record.data.hash !== requestHash) throw new IdempotencyKeyReusedException();
    if (record.data.state === 'pending') throw new IdempotentRequestInProgressException();
    return { kind: 'replay', postId: record.data.postId };
  }

  async complete(
    key: string,
    requestHash: string,
    postId: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(
      key,
      JSON.stringify({ state: 'done', hash: requestHash, postId }),
      'EX',
      ttlSeconds,
    );
  }

  async release(key: string): Promise<void> {
    await this.client.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}

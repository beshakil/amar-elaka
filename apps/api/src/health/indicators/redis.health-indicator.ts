import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { withRetry, withTimeout } from '../../common/utils/with-timeout';

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class RedisHealthIndicator extends HealthIndicator implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) env: Env) {
    super();
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Keep retrying with a capped backoff — never `null` — so the client
      // reconnects on its own once Redis comes back after an outage,
      // instead of leaving /health/ready permanently red until restart.
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      await withRetry(() => withTimeout(this.client.ping(), CHECK_TIMEOUT_MS));
      return this.getStatus(key, true);
    } catch {
      throw new HealthCheckError(
        'Redis health check failed',
        this.getStatus(key, false, { message: 'unreachable' }),
      );
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

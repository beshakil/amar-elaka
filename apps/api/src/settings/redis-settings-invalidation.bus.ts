import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { withRetry, withTimeout } from '../common/utils/with-timeout';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import {
  InvalidationScopeSchema,
  type InvalidationScope,
  type SettingsInvalidationBus,
} from './settings.ports';

const CHANNEL = 'settings:invalidate';

@Injectable()
export class RedisSettingsInvalidationBus implements SettingsInvalidationBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisSettingsInvalidationBus.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly timeoutMs: number;

  constructor(@Inject(APP_CONFIG) env: Env) {
    this.timeoutMs = env.SETTINGS_SOURCE_TIMEOUT_MS;
    this.publisher = new Redis(env.REDIS_URL, { lazyConnect: true });
    this.subscriber = new Redis(env.REDIS_URL, { lazyConnect: true });
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', (error: unknown) => {
        this.logger.warn({ err: error }, 'Settings invalidation Redis connection error');
      });
    }
  }

  async publish(scope: InvalidationScope): Promise<void> {
    const message = JSON.stringify(scope);
    await withRetry(() => withTimeout(this.publisher.publish(CHANNEL, message), this.timeoutMs));
  }

  async subscribe(handler: (scope: InvalidationScope) => void): Promise<void> {
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== CHANNEL) return;
      const scope = this.parse(message);
      if (scope) handler(scope);
    });
    await withRetry(() => withTimeout(this.subscriber.subscribe(CHANNEL), this.timeoutMs));
  }

  onModuleDestroy(): void {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }

  private parse(message: string): InvalidationScope | undefined {
    try {
      const parsed = InvalidationScopeSchema.safeParse(JSON.parse(message));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to the warning below
    }
    this.logger.warn('Ignoring malformed settings invalidation message');
    return undefined;
  }
}

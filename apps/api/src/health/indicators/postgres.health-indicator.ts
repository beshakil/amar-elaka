import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { withRetry, withTimeout } from '../../common/utils/with-timeout';

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class PostgresHealthIndicator extends HealthIndicator implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) env: Env) {
    super();
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: CHECK_TIMEOUT_MS,
    });
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      await withRetry(() => withTimeout(this.pool.query('SELECT 1'), CHECK_TIMEOUT_MS));
      return this.getStatus(key, true);
    } catch {
      throw new HealthCheckError(
        'Postgres health check failed',
        this.getStatus(key, false, { message: 'unreachable' }),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

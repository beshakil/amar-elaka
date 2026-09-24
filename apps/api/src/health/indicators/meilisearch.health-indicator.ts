import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { MeiliSearch } from 'meilisearch';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { withRetry, withTimeout } from '../../common/utils/with-timeout';

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class MeilisearchHealthIndicator extends HealthIndicator {
  private readonly client: MeiliSearch;

  constructor(@Inject(APP_CONFIG) env: Env) {
    super();
    this.client = new MeiliSearch({ host: env.MEILI_HOST, apiKey: env.MEILI_MASTER_KEY });
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      await withRetry(() => withTimeout(this.client.health(), CHECK_TIMEOUT_MS));
      return this.getStatus(key, true);
    } catch {
      throw new HealthCheckError(
        'Meilisearch health check failed',
        this.getStatus(key, false, { message: 'unreachable' }),
      );
    }
  }
}

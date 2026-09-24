import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { MeilisearchHealthIndicator } from './indicators/meilisearch.health-indicator';
import { PostgresHealthIndicator } from './indicators/postgres.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';

// Unprefixed and unversioned on purpose: load balancers / orchestrator
// probes expect stable paths, not /api/v1/health/*.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly meilisearch: MeilisearchHealthIndicator,
  ) {}

  @Get('live')
  @AllowAnyTenant()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @AllowAnyTenant()
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.postgres.check('postgres'),
      () => this.redis.check('redis'),
      () => this.meilisearch.check('meilisearch'),
    ]);
  }
}

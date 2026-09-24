import { createHash } from 'node:crypto';
import { Controller, Get, Headers, HttpStatus, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiNotModifiedResponse, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { AllowAnyTenant } from '../database/allow-any-tenant.decorator';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { NearbyQueryDto } from './dto/nearby-query.dto';
import { ResolveHostQueryDto } from './dto/resolve-host-query.dto';
import {
  ResolvedHostDto,
  TenantConfigDto,
  TenantSummaryDto,
  type ResolvedHost,
  type TenantConfig,
  type TenantSummary,
} from './dto/tenant-responses.dto';
import { TenantsService } from './tenants.service';

@Controller({ version: '1' })
export class TenantsController {
  private readonly configMaxAgeSeconds: number;

  constructor(
    private readonly tenants: TenantsService,
    @Inject(APP_CONFIG) env: Pick<Env, 'TENANT_CACHE_TTL_MS'>,
  ) {
    // settings-exempt: milliseconds-to-seconds, not a business threshold.
    this.configMaxAgeSeconds = Math.max(1, Math.round(env.TENANT_CACHE_TTL_MS / 1000));
  }

  @Get('tenant/config')
  @ApiOkResponse({ type: TenantConfigDto })
  @ApiNotModifiedResponse({ description: 'The client already holds this ETag.' })
  async config(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
  ): Promise<TenantConfig | undefined> {
    const tenantId =
      request.tenantResolution?.kind === 'resolved'
        ? request.tenantResolution.tenant.id
        : undefined;
    if (!tenantId) throw new TenantRequiredException();

    const body = await this.tenants.getConfig(tenantId);
    const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', `public, max-age=${this.configMaxAgeSeconds}, must-revalidate`);

    if (ifNoneMatch === etag) {
      reply.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return body;
  }

  @Get('tenants/nearby')
  @AllowAnyTenant()
  @ApiOkResponse({ type: TenantSummaryDto })
  findNearby(@Query() query: NearbyQueryDto): Promise<TenantSummary> {
    return this.tenants.findNearby(query.lat, query.lng);
  }

  @Get('tenants')
  @AllowAnyTenant()
  @ApiOkResponse({ type: TenantSummaryDto, isArray: true })
  list(): Promise<TenantSummary[]> {
    return this.tenants.list();
  }

  @Get('tenants/resolve')
  @AllowAnyTenant()
  @ApiOkResponse({ type: ResolvedHostDto })
  resolve(@Query() query: ResolveHostQueryDto): Promise<ResolvedHost> {
    return this.tenants.resolveByHost(query.host);
  }
}

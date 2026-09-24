import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { rootDomainSuffixOf, tenantSignalFromHostname } from './hostname-tenant-signal';
import { TenantContext } from './tenant-context';
import { TenantLookupService } from './tenant-lookup.service';
import type { ResolvedTenant, TenantResolutionOutcome } from './tenant-resolution.types';

const TENANT_ID_HEADER = 'x-tenant-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure best-effort resolution — never rejects a request itself. Precedence:
 * X-Tenant-Id header -> subdomain (against APP_ROOT_DOMAIN) -> custom
 * domain. An explicit-but-wrong X-Tenant-Id never falls through to
 * subdomain: a stale client-sent id is a client error, not license to
 * silently resolve to whatever tenant the Host happens to be.
 *
 * Runs after TenantContextMiddleware (opens the store this writes into).
 * Enforcement (reject if unresolved/suspended/terminated, honouring
 * @AllowAnyTenant()) is TenantGateGuard's job, not this middleware's — only
 * a guard can see route metadata.
 */
@Injectable()
export class TenantResolutionMiddleware implements NestMiddleware {
  private readonly rootDomainSuffix: string;

  constructor(
    private readonly lookup: TenantLookupService,
    private readonly context: TenantContext,
    @Inject(APP_CONFIG) env: Pick<Env, 'APP_ROOT_DOMAIN'>,
  ) {
    this.rootDomainSuffix = rootDomainSuffixOf(env.APP_ROOT_DOMAIN);
  }

  async use(
    request: FastifyRequest,
    _response: unknown,
    next: (error?: unknown) => void,
  ): Promise<void> {
    try {
      request.tenantResolution = await this.resolve(request);
      if (request.tenantResolution.kind === 'resolved') {
        const { tenant } = request.tenantResolution;
        this.context.set({ tenantId: tenant.id, tenantStatus: tenant.statusCode });
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  private async resolve(request: FastifyRequest): Promise<TenantResolutionOutcome> {
    const idHeader = firstValue(request.headers[TENANT_ID_HEADER]);
    if (idHeader) {
      if (!UUID_PATTERN.test(idHeader)) return { kind: 'invalid_id' };
      return toOutcome(await this.lookup.resolveById(idHeader));
    }

    const signal = tenantSignalFromHostname(request.headers.host, this.rootDomainSuffix);
    switch (signal.kind) {
      case 'absent':
        return { kind: 'none' };
      // A *.rootDomain host is never someone else's custom domain, so an
      // unrecognised label stops here rather than falling through.
      case 'unusable':
        return { kind: 'not_found' };
      case 'slug':
        return toOutcome(await this.lookup.resolveBySlug(signal.slug));
      case 'custom_domain':
        return toOutcome(await this.lookup.resolveByCustomDomain(signal.domain));
    }
  }
}

function firstValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function toOutcome(tenant: ResolvedTenant | undefined): TenantResolutionOutcome {
  return tenant ? { kind: 'resolved', tenant } : { kind: 'not_found' };
}

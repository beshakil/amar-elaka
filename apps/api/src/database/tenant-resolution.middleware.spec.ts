import type { FastifyRequest } from 'fastify';
import { TenantContext } from './tenant-context';
import { TenantResolutionMiddleware } from './tenant-resolution.middleware';
import type { ResolvedTenant } from './tenant-resolution.types';
import type { TenantLookupService } from './tenant-lookup.service';

const TENANT: ResolvedTenant = {
  id: '0191e3a0-6666-7000-8000-00000000000a',
  slug: 'mirpur',
  customDomain: 'mirpur-bazaar.com',
  statusCode: 'active',
};

function buildMiddleware(
  overrides: Partial<Record<'resolveById' | 'resolveBySlug' | 'resolveByCustomDomain', jest.Mock>>,
) {
  const lookup = {
    resolveById: overrides.resolveById ?? jest.fn().mockResolvedValue(undefined),
    resolveBySlug: overrides.resolveBySlug ?? jest.fn().mockResolvedValue(undefined),
    resolveByCustomDomain:
      overrides.resolveByCustomDomain ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as TenantLookupService;

  const context = new TenantContext();
  const middleware = new TenantResolutionMiddleware(lookup, context, {
    APP_ROOT_DOMAIN: 'amarelaka.local',
  });
  return { lookup, context, middleware };
}

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

async function run(
  middleware: TenantResolutionMiddleware,
  context: TenantContext,
  req: FastifyRequest,
) {
  let error: unknown;
  let contextStore: ReturnType<TenantContext['current']>;
  await context.run(
    {},
    () =>
      new Promise<void>((resolve) => {
        void middleware.use(req, {}, (err) => {
          error = err;
          // Must read the store from inside run() — it's gone once run() returns.
          contextStore = context.current();
          resolve();
        });
      }),
  );
  return { error, resolution: req.tenantResolution, contextStore };
}

describe('TenantResolutionMiddleware', () => {
  it('resolves by X-Tenant-Id when present, without even reading Host', async () => {
    const resolveById = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({ resolveById });
    const req = request({ 'x-tenant-id': TENANT.id, host: 'irrelevant.example.com' });

    const { resolution, contextStore } = await run(middleware, context, req);

    expect(resolveById).toHaveBeenCalledWith(TENANT.id);
    expect(resolution).toEqual({ kind: 'resolved', tenant: TENANT });
    expect(contextStore).toMatchObject({ tenantId: TENANT.id, tenantStatus: 'active' });
  });

  it('a malformed X-Tenant-Id is invalid_id and never falls through to subdomain', async () => {
    const resolveBySlug = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({ resolveBySlug });
    const req = request({ 'x-tenant-id': 'not-a-uuid', host: 'mirpur.amarelaka.local' });

    const { resolution } = await run(middleware, context, req);

    expect(resolution).toEqual({ kind: 'invalid_id' });
    expect(resolveBySlug).not.toHaveBeenCalled();
  });

  it('an X-Tenant-Id that does not match any tenant is not_found, not a fall-through', async () => {
    const resolveBySlug = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({
      resolveById: jest.fn().mockResolvedValue(undefined),
      resolveBySlug,
    });
    const req = request({
      'x-tenant-id': '0191e3a0-0000-7000-8000-000000000000',
      host: 'mirpur.amarelaka.local',
    });

    const { resolution } = await run(middleware, context, req);

    expect(resolution).toEqual({ kind: 'not_found' });
    expect(resolveBySlug).not.toHaveBeenCalled();
  });

  it('falls back to the subdomain when there is no X-Tenant-Id', async () => {
    const resolveBySlug = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({ resolveBySlug });
    const req = request({ host: 'mirpur.amarelaka.local' });

    const { resolution } = await run(middleware, context, req);

    expect(resolveBySlug).toHaveBeenCalledWith('mirpur');
    expect(resolution).toEqual({ kind: 'resolved', tenant: TENANT });
  });

  it('strips a port from the Host header before reading the subdomain', async () => {
    const resolveBySlug = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({ resolveBySlug });
    const req = request({ host: 'mirpur.amarelaka.local:3000' });

    await run(middleware, context, req);

    expect(resolveBySlug).toHaveBeenCalledWith('mirpur');
  });

  it('a *.rootDomain host with an unrecognisable label is not_found, never tried as a custom domain', async () => {
    const resolveByCustomDomain = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({ resolveByCustomDomain });
    const req = request({ host: 'a.b.amarelaka.local' });

    const { resolution } = await run(middleware, context, req);

    expect(resolution).toEqual({ kind: 'not_found' });
    expect(resolveByCustomDomain).not.toHaveBeenCalled();
  });

  it('falls back to a custom domain lookup when the host is not under the root domain', async () => {
    const resolveByCustomDomain = jest.fn().mockResolvedValue(TENANT);
    const { middleware, context } = buildMiddleware({ resolveByCustomDomain });
    const req = request({ host: 'mirpur-bazaar.com' });

    const { resolution } = await run(middleware, context, req);

    expect(resolveByCustomDomain).toHaveBeenCalledWith('mirpur-bazaar.com');
    expect(resolution).toEqual({ kind: 'resolved', tenant: TENANT });
  });

  it('is none when there is no header and no Host at all', async () => {
    const { middleware, context } = buildMiddleware({});
    const req = request({});

    const { resolution } = await run(middleware, context, req);

    expect(resolution).toEqual({ kind: 'none' });
  });

  it('a custom domain that matches nothing is not_found', async () => {
    const { middleware, context } = buildMiddleware({});
    const req = request({ host: 'unknown-domain.com' });

    const { resolution } = await run(middleware, context, req);

    expect(resolution).toEqual({ kind: 'not_found' });
  });

  it('passes lookup errors to next() instead of throwing', async () => {
    const { middleware, context } = buildMiddleware({
      resolveById: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    const req = request({ 'x-tenant-id': TENANT.id });

    const { error } = await run(middleware, context, req);

    expect(error).toBeInstanceOf(Error);
  });
});

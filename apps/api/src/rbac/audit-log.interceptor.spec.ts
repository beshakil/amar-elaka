import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { lastValueFrom, of } from 'rxjs';
import { TenantContext, type AppRole } from '../database/tenant-context';
import { AuditLogInterceptor } from './audit-log.interceptor';
import type { AuditLogService } from './audit-log.service';
import type { RequiredPermission } from './permission.metadata';

function fakeExecutionContext(overrides: Partial<FastifyRequest> = {}): ExecutionContext {
  const request = {
    params: { id: 'post-1' },
    body: { title: 'hello' },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
    id: 'req-1',
    ...overrides,
  } as unknown as FastifyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const NEXT: CallHandler = { handle: () => of({ ok: true }) };

function buildInterceptor(required: RequiredPermission | undefined) {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  // A standalone spy, not accessed via `auditLog.record` in assertions below — that
  // property-access pattern trips @typescript-eslint/unbound-method against the real class type.
  const recordSpy = jest.fn().mockResolvedValue(undefined);
  const auditLog = { record: recordSpy } as unknown as AuditLogService;
  const context = new TenantContext();
  const interceptor = new AuditLogInterceptor(reflector, auditLog, context);
  return { interceptor, recordSpy, context };
}

async function run(interceptor: AuditLogInterceptor, context: TenantContext, role: AppRole) {
  return context.run({ role }, () =>
    lastValueFrom(interceptor.intercept(fakeExecutionContext(), NEXT)),
  );
}

describe('AuditLogInterceptor', () => {
  it('logs a staff write action', async () => {
    const { interceptor, recordSpy, context } = buildInterceptor({
      module: 'posts',
      action: 'write',
    });
    await run(interceptor, context, 'moderator');
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'posts', action: 'write', entityId: 'post-1' }),
    );
  });

  it('logs a staff approve action', async () => {
    const { interceptor, recordSpy, context } = buildInterceptor({
      module: 'posts',
      action: 'approve',
    });
    await run(interceptor, context, 'moderator');
    expect(recordSpy).toHaveBeenCalled();
  });

  it('logs a staff delete action without recording the request body as changes', async () => {
    const { interceptor, recordSpy, context } = buildInterceptor({
      module: 'posts',
      action: 'delete',
    });
    await run(interceptor, context, 'tenant_admin');
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', changes: undefined }),
    );
  });

  it('does not log a staff read action', async () => {
    const { interceptor, recordSpy, context } = buildInterceptor({
      module: 'posts',
      action: 'read',
    });
    await run(interceptor, context, 'moderator');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('does not log a non-staff role, even for a write action (a seller editing their own post)', async () => {
    const { interceptor, recordSpy, context } = buildInterceptor({
      module: 'posts',
      action: 'write',
    });
    await run(interceptor, context, 'seller');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('does not log routes with no @RequirePermission metadata', async () => {
    const { interceptor, recordSpy, context } = buildInterceptor(undefined);
    await run(interceptor, context, 'moderator');
    expect(recordSpy).not.toHaveBeenCalled();
  });
});

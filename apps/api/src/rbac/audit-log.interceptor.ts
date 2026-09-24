import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';
import { TenantContext, type AppRole } from '../database/tenant-context';
import { AuditLogService } from './audit-log.service';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from './permission.metadata';

const LOGGED_ACTIONS = new Set(['write', 'approve', 'delete']);

/** "By a staff role" per the spec — a seller/user acting on their own content is a self-service action, never logged as one. */
const STAFF_ROLES = new Set<AppRole>([
  'moderator',
  'marketer',
  'executive',
  'tenant_admin',
  'partner_owner',
  'platform_admin',
]);

/**
 * Global interceptor (APP_INTERCEPTOR): writes one audit_logs row for every
 * write/approve/delete a staff role performs, with zero per-controller
 * code. Reads the same `@RequirePermission` metadata the guard already
 * checked, so anything gated by it is covered automatically.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
    private readonly tenantContext: TenantContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || !LOGGED_ACTIONS.has(required.action)) {
      return next.handle();
    }

    const role = this.tenantContext.current()?.role;
    if (!role || !STAFF_ROLES.has(role)) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const params = request.params as Record<string, string> | undefined;
    const body = request.body as Record<string, unknown> | undefined;

    return next.handle().pipe(
      tap(() => {
        // Best-effort: a logging failure must never fail the caller's
        // otherwise-successful request.
        this.auditLog
          .record({
            module: required.module,
            action: required.action,
            entityId: params?.id,
            changes: required.action === 'delete' ? undefined : body,
            ipAddress: request.ip,
            userAgent: request.headers['user-agent'],
            requestId: request.id,
          })
          .catch((error: unknown) => {
            this.logger.error({ err: error }, 'Failed to write audit log entry');
          });
      }),
    );
  }
}
